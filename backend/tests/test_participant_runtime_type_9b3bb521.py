"""E-CHAT-CMD S8b real-DB: conversation participants 응답에 runtime_type 노출.

마이그 0106(team_members 뷰 runtime_type) 적용 DB 전제. GET /api/v2/conversations 의 participant
객체에 runtime_type 포함(에이전트=뷰 값·휴먼/미설정=None) 검증. S8 composer pre-send 경고 언블록.

DB env 없으면 skip — CI alembic-fresh-db 잡에서 실행.
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


ORG = uuid.UUID("a8b00000-0000-0000-0000-000000000001")
P1 = uuid.UUID("a8b00000-0000-0000-0000-0000000000a1")
CONV = uuid.UUID("a8b00000-0000-0000-0000-0000000000d1")
AG_SENDER = uuid.UUID("a8b00000-0000-0000-0000-0000000000e1")  # API key 인증 주체(에이전트)
AG_HERMES = uuid.UUID("a8b00000-0000-0000-0000-0000000000e2")  # runtime_type=hermes
U_HUMAN = uuid.UUID("a8b00000-0000-0000-0000-0000000000b1")
OM_HUMAN = uuid.UUID("a8b00000-0000-0000-0000-0000000000c1")   # 휴먼 participant(runtime_type None)


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AG_SENDER}','{AG_HERMES}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{U_HUMAN}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A8B','a8borg','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0)",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{U_HUMAN}','h@a8b.test','x','H',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_HUMAN}','{ORG}','{U_HUMAN}','member')",
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{AG_SENDER}','{ORG}','agent','SenderBot',true),"
        f"('{AG_HERMES}','{ORG}','agent','HermesBot',true)",
        f"INSERT INTO members (id,org_id,type,user_id,name,is_active) VALUES ('{OM_HUMAN}','{ORG}','human','{U_HUMAN}','H',true)",
        f"UPDATE members SET runtime_type='hermes' WHERE id='{AG_HERMES}'",
        # 에이전트 뷰 출현
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AG_SENDER}','{P1}','dev',9601),"
        f"(gen_random_uuid(),'{AG_HERMES}','{P1}','dev',9602)",
        f"INSERT INTO conversations (id,project_id,org_id,type,created_by) VALUES ('{CONV}','{P1}','{ORG}','group','{AG_SENDER}')",
        "INSERT INTO conversation_participants (conversation_id,member_id) VALUES "
        f"('{CONV}','{AG_SENDER}'),('{CONV}','{AG_HERMES}'),('{CONV}','{OM_HUMAN}')",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


def _auth():
    c = MagicMock()
    c.user_id = str(AG_SENDER)
    c.claims = {"app_metadata": {"org_id": str(ORG), "api_key_id": "ak-test"}}
    return c


@pytest.mark.anyio
async def test_conversations_participants_include_runtime_type():
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
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: _auth()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                resp = await c.get(f"/api/v2/conversations?project_id={P1}")
            assert resp.status_code == 200, resp.text
            convs = resp.json().get("data", [])
            conv = next((cv for cv in convs if cv["id"] == str(CONV)), None)
            assert conv is not None, f"conv 미반환: {[cv['id'] for cv in convs]}"
            parts = {p["member_id"]: p for p in conv["participants"]}
            # AC1: 모든 participant 객체에 runtime_type 키 존재
            assert all("runtime_type" in p for p in conv["participants"]), "participant에 runtime_type 키 부재"
            # 에이전트(hermes) = 뷰 값, 휴먼 = None
            assert parts[str(AG_HERMES)]["runtime_type"] == "hermes", f"hermes 미노출: {parts[str(AG_HERMES)]}"
            assert parts[str(OM_HUMAN)]["runtime_type"] is None, f"휴먼 runtime_type None 아님: {parts[str(OM_HUMAN)]}"
            # 회귀: 기존 필드(type) 유지
            assert parts[str(AG_HERMES)]["type"] == "agent" and parts[str(OM_HUMAN)]["type"] == "human"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
