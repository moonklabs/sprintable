"""E-CHAT-CMD S1b real-DB: team_members 뷰 runtime_type 노출 + PATCH/GET round-trip.

마이그 0106 적용 DB 전제. AC: PATCH /api/v2/team-members/{id} {runtime_type} → 200 + 실저장
(members.runtime_type) + GET 반환 + 회귀 0. message_policy_mode(0096) 선례 동형.

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡에서 실행.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest

_RAW_URL = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.UUID("f1b60000-0000-0000-0000-000000000001")
P1 = uuid.UUID("f1b60000-0000-0000-0000-0000000000a1")
U_OWNER = uuid.UUID("f1b60000-0000-0000-0000-0000000000b1")
OM_OWNER = uuid.UUID("f1b60000-0000-0000-0000-0000000000c1")
M_AGENT = uuid.UUID("f1b60000-0000-0000-0000-0000000000e1")


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM agent_project_profiles WHERE member_id = '{M_AGENT}'",
        f"DELETE FROM project_access WHERE project_id = '{P1}'",
        f"DELETE FROM members WHERE org_id = '{ORG}'",
        f"DELETE FROM projects WHERE org_id = '{ORG}'",
        f"DELETE FROM org_members WHERE org_id = '{ORG}'",
        f"DELETE FROM users WHERE id = '{U_OWNER}'",
        f"DELETE FROM organizations WHERE id = '{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','F1B6','f1b6org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{U_OWNER}','owner@f1b6.test','x','Owner',true,true,0,false,0)",
        # auth user = org owner → assert_agent_owner 가 _is_org_admin 으로 통과
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_OWNER}','{ORG}','{U_OWNER}','owner')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0)",
        # 휴먼 anchor(owner) + 에이전트 anchor(runtime_type 초기 NULL)
        "INSERT INTO members (id,org_id,type,user_id,name,org_role,is_active) VALUES "
        f"('{OM_OWNER}','{ORG}','human','{U_OWNER}','Owner','owner',true)",
        "INSERT INTO members (id,org_id,type,owner_member_id,name,is_active) VALUES "
        f"('{M_AGENT}','{ORG}','agent','{OM_OWNER}','RuntimeBot',true)",
        # 에이전트 뷰 출현(agent 분기 = members ⋈ agent_project_profiles)
        f"INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) "
        f"VALUES (gen_random_uuid(),'{M_AGENT}','{P1}','dev',9401)",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


def _auth():
    c = MagicMock()
    c.user_id = str(U_OWNER)
    c.claims = {"app_metadata": {"org_id": str(ORG)}}
    return c


@pytest.mark.anyio
async def test_view_exposes_runtime_type_human_null_agent_value():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("UPDATE members SET runtime_type='hermes' WHERE id=:i"), {"i": str(M_AGENT)})
            await s.commit()
        async with Session() as s:
            agent_rt = (await s.execute(text(
                "SELECT runtime_type FROM team_members WHERE id=:i"), {"i": str(M_AGENT)})).scalar_one()
            human_rt = (await s.execute(text(
                "SELECT runtime_type FROM team_members WHERE id=:i"), {"i": str(OM_OWNER)})).scalar_one_or_none()
        assert agent_rt == "hermes", f"뷰 agent runtime_type 미노출: {agent_rt}"
        # 휴먼은 뷰 출현 시 runtime_type NULL (미설정). project_access 없으면 휴먼 뷰행 0 — None 허용.
        assert human_rt in (None,), f"휴먼 runtime_type NULL 아님: {human_rt}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_runtime_type_persists_and_get_returns():
    """⚠️ AC 핵심: PATCH {runtime_type} → 200 + members 실저장 + GET 반환."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        async def override_db():
            # 실 get_db 동형: yield 후 commit(미commit 시 PATCH write 롤백 — verify_commit_race).
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: _auth()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                # PATCH runtime_type
                r = await c.patch(f"/api/v2/team-members/{M_AGENT}", json={"runtime_type": "openclaw"})
                assert r.status_code == 200, r.text
                assert r.json()["runtime_type"] == "openclaw", f"PATCH 응답 미반영: {r.json().get('runtime_type')}"
                # GET (project-scoped) → 반환
                g = await c.get(f"/api/v2/team-members?project_id={P1}&type=agent")
                assert g.status_code == 200, g.text
                agent = next((m for m in g.json() if m["id"] == str(M_AGENT)), None)
                assert agent is not None and agent["runtime_type"] == "openclaw", f"GET 미반환: {agent}"
        finally:
            app.dependency_overrides.clear()

        # 실저장 확인: canonical members.runtime_type
        async with Session() as s:
            saved = (await s.execute(text(
                "SELECT runtime_type FROM members WHERE id=:i"), {"i": str(M_AGENT)})).scalar_one()
        assert saved == "openclaw", f"members.runtime_type 실저장 실패: {saved}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_unrelated_field_does_not_touch_runtime_type():
    """회귀: 다른 필드 PATCH 가 runtime_type 을 건드리지 않음(부분 갱신 격리)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("UPDATE members SET runtime_type='grok' WHERE id=:i"), {"i": str(M_AGENT)})
            await s.commit()

        async def override_db():
            # 실 get_db 동형: yield 후 commit(미commit 시 PATCH write 롤백 — verify_commit_race).
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: _auth()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                r = await c.patch(f"/api/v2/team-members/{M_AGENT}", json={"name": "Renamed"})
                assert r.status_code == 200, r.text
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            rt = (await s.execute(text(
                "SELECT runtime_type FROM members WHERE id=:i"), {"i": str(M_AGENT)})).scalar_one()
        assert rt == "grok", f"무관 PATCH 가 runtime_type 변경: {rt}"
    finally:
        await engine.dispose()
