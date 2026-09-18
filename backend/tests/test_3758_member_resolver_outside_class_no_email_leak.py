"""story #3758(BE·표시명·결함 클래스 별건④, 페드루 PO 決 2026-09-09) real-DB 회귀 — 원 9자리
목록의 6 SQL COALESCE 자리(members.py·org_members.py×2·project_access.py·
agent_message_policy.py·team_member.py) 응답 name 필드가 display_name 없는 휴먼에게
email/id를 지어내지 않고 정직하게 None을 돌리는지 실 Postgres 왕복으로 고정.

양성대조 축: U_NULL(display_name=NULL, members 앵커도 없음 — COALESCE 두 항 모두 빈값)이
각 엔드포인트 응답에서 name=None(「@」 0)으로 나오는지. 대조군: U_NAMED(display_name 有)가
그대로 실명으로 나오는지(무회귀).

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡.
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


ORG = uuid.UUID("37580000-0000-0000-0000-000000000001")
P1 = uuid.UUID("37580000-0000-0000-0000-0000000000a1")
U_OWNER = uuid.UUID("37580000-0000-0000-0000-0000000000b1")
U_NULL = uuid.UUID("37580000-0000-0000-0000-0000000000b2")
OM_OWNER = uuid.UUID("37580000-0000-0000-0000-0000000000c1")
OM_NULL = uuid.UUID("37580000-0000-0000-0000-0000000000c2")
AG1 = uuid.UUID("37580000-0000-0000-0000-0000000000e1")


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM agent_message_allowlist WHERE agent_member_id = '{AG1}'",
        f"DELETE FROM agent_project_profiles WHERE member_id = '{AG1}'",
        f"DELETE FROM project_access WHERE project_id = '{P1}'",
        f"DELETE FROM members WHERE org_id = '{ORG}'",
        f"DELETE FROM projects WHERE org_id = '{ORG}'",
        f"DELETE FROM org_members WHERE org_id = '{ORG}'",
        f"DELETE FROM users WHERE id IN ('{U_OWNER}','{U_NULL}')",
        f"DELETE FROM organizations WHERE id = '{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','E3758','e3758org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{U_OWNER}','owner@e3758.test','x','Owner Kim',true,true,0,false,0),"
        # story #3758 핵심 표본 — display_name NULL(email/id 폴백 클래스가 이 자리들에서
        # 살아있으면 name 필드에 이 email이 그대로 샌다).
        f"('{U_NULL}','nulldisplay@e3758.test','x',NULL,true,true,0,false,0)",
        "INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{OM_OWNER}','{ORG}','{U_OWNER}','owner'),"
        # role=admin — org_members.py eligible-approvers(owner/admin만 반환) 표본도 겸함.
        f"('{OM_NULL}','{ORG}','{U_NULL}','admin')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0)",
        # canonical members 앵커는 U_OWNER만 생성(실명 대조군). U_NULL은 앵커 자체가
        # 없다 — members.py/org_members.py 등의 COALESCE 첫 항(m.name)도 빈값이라
        # 두 번째 항(u.display_name, 이것도 NULL)까지 전부 소진해야 하는 최악 표본.
        "INSERT INTO members (id,org_id,type,user_id,name,org_role,is_active) VALUES "
        f"('{OM_OWNER}','{ORG}','human','{U_OWNER}','Owner Kim','owner',true),"
        f"('{AG1}','{ORG}','agent',NULL,'CandidateBot',NULL,true)",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AG1}','{P1}','dev',9758)",
        # U_NULL을 프로젝트에 grant(members.py project_id-스코프 branch가 grant 경로도
        # 타는지 함께 확인 — admin이라 floor로도 통과하지만 이중 경로 무관 확인 목적).
        "INSERT INTO project_access (id,project_id,org_member_id,member_id,permission,role,access_source) VALUES "
        f"(gen_random_uuid(),'{P1}','{OM_NULL}',NULL,'granted','member','direct')",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


def _auth(uid: uuid.UUID, org_id: uuid.UUID = ORG):
    ctx = MagicMock()
    ctx.user_id = str(uid)
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    return ctx


async def _get(session_factory, path: str, uid: uuid.UUID):
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    async def override_db():
        async with session_factory() as s:
            yield s

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = lambda: _auth(uid)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            return await c.get(path)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_all_six_sql_sites_return_none_not_email_for_display_name_null_human():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        # ① members.py — project_id 스코프(라우터 자리)
        resp = await _get(Session, f"/api/v2/members?project_id={P1}", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert by_id[str(OM_NULL)]["name"] is None, by_id[str(OM_NULL)]
        assert by_id[str(OM_OWNER)]["name"] == "Owner Kim"

        # ② members.py — project_id 없음(team_member.py list_org_human_members 경유)
        resp = await _get(Session, "/api/v2/members", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert by_id[str(OM_NULL)]["name"] is None
        assert by_id[str(OM_OWNER)]["name"] == "Owner Kim"

        # ③ org_members.py — list_org_members(admin/owner 전용, email 포함 전체 로스터)
        resp = await _get(Session, "/api/v2/org-members", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert by_id[str(OM_NULL)]["name"] is None
        assert by_id[str(OM_NULL)]["email"] == "nulldisplay@e3758.test"  # email 필드 자체는 유지(별개 축)

        # ④ org_members.py — eligible-approvers(owner/admin만, U_NULL=admin이라 포함됨)
        resp = await _get(Session, "/api/v2/org-members/eligible-approvers", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert str(OM_NULL) in by_id, f"admin인데 eligible-approvers에 누락: {by_id}"
        assert by_id[str(OM_NULL)]["name"] is None

        # ⑤ project_access.py — access-candidates(project owner/admin 호출, 모든 org member 후보)
        resp = await _get(Session, f"/api/v2/projects/{P1}/access-candidates", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert by_id[str(OM_NULL)]["name"] is None

        # ⑥ agent_message_policy.py — message-policy/candidates(agent owner=org owner)
        resp = await _get(Session, f"/api/v2/agents/{AG1}/message-policy/candidates", U_OWNER)
        assert resp.status_code == 200, resp.text
        by_id = {m["id"]: m for m in resp.json()}
        assert by_id[str(OM_NULL)]["name"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_human_member_writes_none_not_email_when_display_name_missing():
    """agent_anchor_sync.ensure_human_member(#3758 10번째, 쓰기 층) — display_name 없으면
    members.name에 email/user_id를 INSERT하지 않고 None을 정직하게 저장하는지."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.agent_anchor_sync import ensure_human_member

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            # U_NULL의 members 앵커를 일부러 지워 ensure_human_member가 새로 만들게 한다.
            await s.execute(text(f"DELETE FROM members WHERE id = '{OM_NULL}'"))
            await s.commit()

        async with Session() as s:
            ok = await ensure_human_member(s, OM_NULL)
            await s.commit()
        assert ok is True

        async with Session() as s:
            name = (await s.execute(
                text("SELECT name FROM members WHERE id = :id"), {"id": str(OM_NULL)}
            )).scalar_one()
        assert name is None, f"email/uuid 폴백 재발 — {name!r}"
    finally:
        await engine.dispose()
