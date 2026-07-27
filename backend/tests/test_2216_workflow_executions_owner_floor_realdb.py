"""story #2216(#2215 AC 항목3 전수 스윕 CONFIRMED-SUSPECT): `GET /workflow-executions`의
self-scope 체크(`role not in ("admin","owner")`일 때 caller가 자기 자신의 member_id로만
조회하는지 검증)가 `TeamMember`(=team_members뷰, members ⋈ project_access INNER JOIN)
단독 조회를 썼다 — grant-only 휴먼(명시 project_access grant를 org_member_id 경유로만
가진, team_members/members 행이 없는 member)이 자기 자신의 실행 이력을 조회하려 해도
"Can only query own executions"(403)으로 오판됐다.

처방: TeamMember 조회가 빈 채로 오면 org_members SSOT(filter_org_member_ids와 동일 축)로
폴백 — member_id가 caller 본인의 org_member.id이고 그 user_id가 caller와 일치하는지 확認.
새 규칙 발명 0.

가드 3종:
  ① grant-only 휴먼이 자기 member_id로 자기 실행이력 조회 성공(결함이 있던 조건 그대로)
  ② 타인의 member_id로 조회하면 여전히 403(self-scope 방어 안 헐거워짐)
  ③ 기존 team_member 기반(project grant 有) 휴먼은 여전히 정상 동작(회귀 없음)
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2216d00-0000-0000-0000-000000000010")
GRANT_ONLY_USER = uuid.UUID("d2216d00-0000-0000-0000-000000000011")
OTHER_USER = uuid.UUID("d2216d00-0000-0000-0000-000000000012")
TM_HUMAN_USER = uuid.UUID("d2216d00-0000-0000-0000-000000000013")
PROJ = uuid.UUID("d2216d00-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email=None,
        claims={"app_metadata": {"org_id": str(ORG), "role": "member"}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM project_access WHERE project_id IN "
        f"(SELECT id FROM projects WHERE org_id='{ORG}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{GRANT_ONLY_USER}','{OTHER_USER}','{TM_HUMAN_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s) -> dict[str, uuid.UUID]:
    await _clean(s)
    for sql in [
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2216d-org','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{GRANT_ONLY_USER}','grantonly@d2216d.test','x','GrantOnly',true,true,0,false,0),"
        f"('{OTHER_USER}','other@d2216d.test','x','Other',true,true,0,false,0),"
        f"('{TM_HUMAN_USER}','tm@d2216d.test','x','TM',true,true,0,false,0)",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2216d-proj','warn')",
    ]:
        await s.execute(text(sql))
    grant_only_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{GRANT_ONLY_USER}','member') RETURNING id"
    ))).one()
    other_row = (await s.execute(text(
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"(gen_random_uuid(),'{ORG}','{OTHER_USER}','member') RETURNING id"
    ))).one()
    tm_member_id = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{tm_member_id}','{ORG}','{TM_HUMAN_USER}','human','TM',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{tm_member_id}','granted')"
    ))
    # ⚠️GRANT_ONLY_USER/OTHER_USER: members/team_members 어디에도 안 넣음(team_member 행 없음).
    await s.commit()
    return {"grant_only_om": grant_only_row[0], "other_om": other_row[0], "tm_member": tm_member_id}


@pytest.mark.anyio
async def test_grant_only_member_can_query_own_executions():
    """① grant-only 휴먼이 자기 member_id로 자기 실행이력 조회 성공(결함 있던 조건 그대로)."""
    from app.routers.workflow_executions import list_executions
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            out = await list_executions(
                project_id=PROJ, event_type=None, status=None, story_id=None,
                member_id=ids["grant_only_om"], offset=0, limit=20,
                db=s, org_id=ORG, auth=_auth(GRANT_ONLY_USER),
            )
        assert out.items == []  # 실행 이력은 안 심었음 — 403 안 났다는 것 자체가 이 테스트의 요지.
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_other_member_id_still_403():
    """② 타인의 member_id로 조회하면 여전히 403(self-scope 방어 안 헐거워짐)."""
    from app.routers.workflow_executions import list_executions
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await list_executions(
                    project_id=PROJ, event_type=None, status=None, story_id=None,
                    member_id=ids["other_om"], offset=0, limit=20,
                    db=s, org_id=ORG, auth=_auth(GRANT_ONLY_USER),
                )
        assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_team_member_based_human_still_works():
    """③ 되던 것이 계속 됨 — project grant 있는 정상 team_member 휴먼은 무회귀."""
    from app.routers.workflow_executions import list_executions
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
        async with Session() as s:
            out = await list_executions(
                project_id=PROJ, event_type=None, status=None, story_id=None,
                member_id=ids["tm_member"], offset=0, limit=20,
                db=s, org_id=ORG, auth=_auth(TM_HUMAN_USER),
            )
        assert out.items == []
    finally:
        await eng.dispose()
