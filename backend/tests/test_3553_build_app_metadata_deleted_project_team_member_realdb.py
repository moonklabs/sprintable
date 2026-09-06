"""story #3553(BE·결함·소형, 페드루 PO 確定, 2026-09-06) — `_build_app_metadata`의 TeamMember
조회 2곳(last_project_id 우선·가장 오래된 team_member)이 `projects` JOIN·deleted_at 필터
없이 삭제된 project를 가리키는 team_member 행도 「접근 가능」으로 잡던 결함.

`first_accessible_project_id`(branch1)·`has_project_access`(_project_access_predicate)는
이미 `Project.deleted_at IS NULL`을 보는데 이 두 조회만 비대칭이었다 — 삭제 프로젝트에
team_member 행만 남아 있는 유저가 그 죽은 project로 착지하던 클래스(0746과 같은 "cross-org/
dead 프로젝트 누수" 계열)."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("35530000-0000-0000-0000-0000000011a1")
USER = uuid.UUID("35530000-0000-0000-0000-000000011111")
PROJ_DELETED = uuid.UUID("35530000-0000-0000-0000-000000013331")  # 오래된 team_member가 가리키는 삭제 project
PROJ_LIVE = uuid.UUID("35530000-0000-0000-0000-000000013332")     # owner org-wide로 접근 가능한 살아있는 project
TM = uuid.UUID("35530000-0000-0000-0000-000000014441")
OM = uuid.UUID("35530000-0000-0000-0000-000000015551")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM project_access WHERE member_id='{TM}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S3553Org2','s3553-org2','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u2@s3553.test','x','U',true,true,0,false,0)",
        # 삭제된 project + 그걸 가리키는(가장 오래된) team_member(뷰 0088 — members+project_access
        # 조합, created_at=members.created_at) 행 — fix 前엔 이게 잡혔다.
        f"INSERT INTO projects (id,org_id,name,slug,violation_level,deleted_at) VALUES "
        f"('{PROJ_DELETED}','{ORG}','Deleted','s3553-proj-deleted','warn',now())",
        f"INSERT INTO members (id,org_id,type,user_id,name,created_at) VALUES "
        f"('{TM}','{ORG}','human','{USER}','U',now() - interval '10 days')",
        f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ_DELETED}','{TM}','granted','member')",
        # 살아있는 project — owner org-wide로만 접근 가능(team_member 행 없음, first_accessible_
        # project_id branch3와 동형 — 0746 분기가 이걸로 정확히 해소해야 한다).
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ_LIVE}','{ORG}','Live','s3553-proj-live','warn')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','owner')",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytest.mark.anyio
async def test_deleted_project_team_member_does_not_block_live_project_resolution():
    """가장 오래된(유일한) team_member가 삭제된 project를 가리키면, fix 前엔 그 죽은
    project_id로 착지했다 — fix 後엔 그 team_member를 무시하고(deleted_at 필터) 0746
    분기의 first_accessible_project_id(owner org-wide)가 살아있는 project로 해소한다."""
    from app.routers.auth import _build_app_metadata
    from app.models.user import User as UserModel

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            user = await s.get(UserModel, USER)
            with patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
                md = await _build_app_metadata(user, s, org_id=ORG)

        assert md["project_id"] == str(PROJ_LIVE), (
            f"삭제된 project({PROJ_DELETED})를 가리키는 team_member 행이 여전히 «접근 가능»으로 "
            f"잡혀 project_id={md['project_id']}로 나갔으면 #3553 그대로 재발 — "
            "TeamMember 조회에 projects JOIN·deleted_at IS NULL이 빠진 결함."
        )
        assert md["role"] == "owner"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_last_project_id_pointing_at_deleted_project_does_not_block_live_project_resolution():
    """카디르 QA(2026-09-06) — 위 테스트는 `user.last_project_id`가 비어(None) search-1
    ("last_project_id 우선", :440~448)을 안 태우고 search-2("가장 오래된 team_member",
    :455~461)만 태워, search-1의 JOIN을 지워도 RED 0이었다(양성대조가 그 분기를 실제로
    안 잰 것). `users.last_project_id`가 **삭제된 project를 직접 가리키는** 표본으로
    search-1을 명시적으로 태운다 — fix 前엔 search-1이 그 team_member 행을 그대로
    찾아 죽은 project_id로 착지했다."""
    from app.routers.auth import _build_app_metadata
    from app.models.user import User as UserModel

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text(f"UPDATE users SET last_project_id='{PROJ_DELETED}' WHERE id='{USER}'"))
            await s.commit()

        async with Session() as s:
            user = await s.get(UserModel, USER)
            assert user is not None and user.last_project_id == PROJ_DELETED, "seed 확인 — last_project_id가 의도대로 안 실렸다"
            with patch("app.routers.auth._user_projects_claim", new=AsyncMock(return_value=[])):
                md = await _build_app_metadata(user, s, org_id=ORG)

        assert md["project_id"] == str(PROJ_LIVE), (
            f"user.last_project_id가 삭제된 project({PROJ_DELETED})를 직접 가리키는데 search-1"
            f"(:440~448)이 그 team_member 행을 여전히 «접근 가능»으로 잡아 project_id="
            f"{md['project_id']}로 나갔으면 #3553 그대로 재발 — search-1 JOIN·deleted_at 필터 결함."
        )
        assert md["role"] == "owner"
    finally:
        await eng.dispose()
