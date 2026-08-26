"""story #2873(P0, 미르코 홀름 라이브 재검증 — 2026-08-21) — 0-프로젝트 org로 전환한 뒤
`/api/me`가 전환을 반영하지 않고 최초 가입 org("뭉클랩")를 계속 반환하는 결함.

## 실측 경과
BE 재발급 경로 전수(refresh rotation·switch_organization·switch_project·switch_account·
oauth_callback) — 전부 `user.last_org_id`/JWT `app_metadata.org_id` claim을 정확히 갱신·전파함을
확認(코드 레벨 반증 없음). 그런데 미르코군이 라이브에서 **refresh 호출 0회·최초 `/api/me`
조회부터** stale임을 잡아 재발급 가설을 기각 — 실제 결함은 **소비 측**(`me.py::get_me`)에 있었다.

## 근본 원인
`get_me()`(JWT 인증 분기, org 무관 project_id 우선 조회)가 `app_metadata.project_id`를
`if project_id_str:`로만 게이팅한다. 0-프로젝트 org의 project_id claim은 **빈 문자열("")** —
falsy라 else 분기로 떨어지는데, 그 분기(`TeamMember.user_id == uid`)가 **org_id를 전혀 걸지
않는다.** 멀티-org 유저(이 org 외에 프로젝트 있는 org에도 소속)는 그 다른 org의 team_members
행이 org-blind 쿼리에 매치돼 그대로 반환됨 — org_id claim(정확)은 애초에 조회에 안 쓰인다.
`update_me()`(PATCH)에도 동일 결함이 복제돼 있었다(②grep 전수로 확認, 같은 처방 적용).

## 처방
project_id claim이 없을 때(None 또는 "") org_id claim으로 스코프 — 그 org에 team_members 행이
없으면(0-프로젝트 org는 애초에 정상 형태) `member is None`으로 org_members 기반 폴백(기존
`org_id_str` 분기, 179행대)으로 정확히 떨어진다.

이 테스트는 재현(멀티-org 유저·타깃 org=0-프로젝트)과 fix 하중을 함께 증명한다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG_A = uuid.UUID("28730000-0000-0000-0000-0000000001a1")  # 프로젝트 有 org(최초 가입·"뭉클랩")
ORG_B = uuid.UUID("28730000-0000-0000-0000-0000000001b1")  # 0-프로젝트 org(전환 타깃)
USER = uuid.UUID("28730000-0000-0000-0000-000000001111")
OM_A = uuid.UUID("28730000-0000-0000-0000-0000000002a1")  # org_members.id == members.id(휴먼 앵커)
OM_B = uuid.UUID("28730000-0000-0000-0000-0000000002b1")
PROJ_A = uuid.UUID("28730000-0000-0000-0000-000000003333")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
        f"DELETE FROM members WHERE org_id IN ('{ORG_A}','{ORG_B}')",
        f"DELETE FROM org_members WHERE org_id IN ('{ORG_A}','{ORG_B}')",
        f"DELETE FROM projects WHERE org_id='{ORG_A}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id IN ('{ORG_A}','{ORG_B}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES "
        f"('{ORG_A}','MoonkLab','s2873-org-a','free'),('{ORG_B}','ZeroProj','s2873-org-b','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','u@s2873.test','x','U',true,true,0,false,0)",
        # ORG_A: 최초 가입 org — 프로젝트+team_members 행 有(멀티-org 유저의 "다른" org).
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_A}','{ORG_A}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,user_id,name) VALUES "
        f"('{OM_A}','{ORG_A}','human','{USER}','U')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ_A}','{ORG_A}','P','s2873-proj-a','warn')",
        f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ_A}','{OM_A}','granted','member')",
        # ORG_B: 전환 타깃 — 0-프로젝트(project_access/team_members 행 없음), org_members만.
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_B}','{ORG_B}','{USER}','member')",
    ]:
        await s.execute(text(sql))
    await s.commit()


def _auth_switched_to_org_b():
    from app.dependencies.auth import AuthContext
    # switch_organization()이 실제로 발급하는 claim 형태 그대로: org_id=신규 org, project_id=""
    # (0-프로젝트 org는 first_accessible_project_id가 None → _build_app_metadata가 "" 직렬화).
    return AuthContext(
        user_id=str(USER), email="u@s2873.test",
        claims={"app_metadata": {"org_id": str(ORG_B), "project_id": ""}},
        org_id=str(ORG_B),
    )


@pytest.mark.anyio
async def test_get_me_after_switch_to_zero_project_org_returns_target_org_not_first_org():
    from app.routers.me import get_me

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            resp = await get_me(member_id=None, session=s, auth=_auth_switched_to_org_b())

        assert resp.org_id == ORG_B, (
            f"org_id claim(={ORG_B}, 0-프로젝트 org 전환 직후 정확값)을 무시하고 org-blind "
            f"team_members 폴백이 다른 org({resp.org_id})를 반환하면 #2873 그대로 재발 — "
            f"project_id claim이 빈 문자열일 때도 org_id로 스코프해야 한다."
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_update_me_after_switch_to_zero_project_org_patches_target_org_profile():
    """update_me()도 get_me()와 동일 결함 클래스(②grep 전수로 발견) — org-blind 폴백이면 PATCH가
    ORG_A의 team_members 이름을 바꿔버리고(엉뚱한 org write) ORG_B는 org_members 폴백 경로로
    응답만 만들어 실제로는 아무것도 갱신 안 된 것처럼 보인다. fix 후엔 org_members.name(User
    표시명 경유) 갱신 경로를 타야 한다 — 최소한 ORG_A의 team_members.name은 절대 바뀌면 안 된다."""
    from app.routers.me import update_me
    from app.schemas.me import UpdateMe

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            # update_me()는 self-commit이 없다(get_db 의존성 래퍼가 정상 요청 경로에서 커밋 —
            # #2874 update_doc과 동일 함정, 직접 호출 시 명시 커밋 필요).
            await update_me(
                UpdateMe(name="Renamed-By-OrgB-Patch"),
                member_id=None, session=s, auth=_auth_switched_to_org_b(),
            )
            await s.commit()

        async with Session() as s:
            member_a_name = (await s.execute(
                text(f"SELECT name FROM members WHERE id='{OM_A}'")
            )).scalar_one()

        assert member_a_name == "U", (
            f"ORG_B(전환 타깃)로 인증된 PATCH가 ORG_A의 members.name을 '{member_a_name}'로 "
            f"바꿨으면 org-blind 폴백이 엉뚱한 org의 프로필을 침묵 오염시킨 것 — #2873과 동일 "
            f"결함 클래스가 write 경로에도 있었다는 뜻."
        )
    finally:
        await eng.dispose()
