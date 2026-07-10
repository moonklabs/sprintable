"""E-SECURITY SEC-S8(story 83ea3d6a) V: 대화(conversation) 에이전트 admin-bypass의 project-scope
미검증 봉쇄 실증.

`_effective_org_role`이 에이전트 호출에 대해 sender.role(=`_resolve_member`의 비결정 `.first()`가
뽑은 임의 project row role)을 org-wide 권한인 것처럼 신뢰했다 — mixed-role 에이전트(예:
project_x=admin·project_y=grant 0)가 project_x의 admin 지위를 빌려와 project_y의 agent-only
대화를 admin-bypass로 열람할 수 있었다(참가자 아님에도 200, 까심 전수스윕 실HTTP 확定)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org(project_x, project_y) + mixed-role agent(X=admin grant, Y=grant 0) +
    other_agent(Y=member grant, Y 대화의 유일 참가자)."""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_x = Project(id=uuid.uuid4(), org_id=org.id, name="Project X")
    project_y = Project(id=uuid.uuid4(), org_id=org.id, name="Project Y")
    session.add_all([project_x, project_y])
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="mixed-role-agent", is_active=True)
    session.add(agent)
    await session.commit()
    agent_id = agent.id
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_x.id, member_id=agent_id, permission="granted", role="admin",
    ))
    await session.commit()

    other_agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="other-agent-y", is_active=True)
    session.add(other_agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_y.id, member_id=other_agent.id, permission="granted", role="member",
    ))
    await session.commit()

    # project_y agent-only 대화 — 유일 참가자는 other_agent(mixed-role 에이전트는 참가자 아님).
    conv_y = Conversation(
        id=uuid.uuid4(), project_id=project_y.id, org_id=org.id, type="dm",
        title="Y-only agent convo", created_by=other_agent.id,
    )
    session.add(conv_y)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv_y.id, member_id=other_agent.id))
    await session.commit()

    # project_x agent-only 대화 — mixed-role 에이전트가 X에서는 진짜 admin(회귀 0 확인용).
    conv_x = Conversation(
        id=uuid.uuid4(), project_id=project_x.id, org_id=org.id, type="dm",
        title="X-only agent convo", created_by=other_agent.id,
    )
    session.add(conv_x)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv_x.id, member_id=other_agent.id))
    await session.commit()

    return {
        "org_id": org.id, "project_x_id": project_x.id, "project_y_id": project_y.id,
        "agent_id": agent_id, "conv_x_id": conv_x.id, "conv_y_id": conv_y.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_agent(app, Session, agent_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(agent_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_mixed_role_agent_cannot_get_conversation_without_project_grant():
    """V 재현: project_x=admin·project_y=grant 0인 에이전트가 project_y 대화 GET → 403
    (기존엔 admin-bypass가 임의 row role로 통과해 200이었음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{seeded['conv_y_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mixed_role_agent_cannot_list_messages_without_project_grant():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{seeded['conv_y_id']}/messages")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_agent_can_still_bypass_in_own_admin_project():
    """회귀 0: project_x에서 진짜 admin인 에이전트는 project_x의 agent-only 대화를 여전히
    admin-bypass로 열람 가능(과차단 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/conversations/{seeded['conv_x_id']}")
            assert resp.status_code == 200, resp.text

            resp2 = await client.get(f"/api/v2/conversations/{seeded['conv_x_id']}/messages")
            assert resp2.status_code == 200, resp2.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_include_agent_conversations_blocked_for_non_admin_project():
    """V 재현(list_conversations 축): mixed-role 에이전트가 project_y로 include_agent_conversations
    요청 → 403(project_y에선 admin 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations",
                params={"project_id": str(seeded["project_y_id"]), "include_agent_conversations": "true"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_include_agent_conversations_allowed_for_admin_project():
    """회귀 0: project_x(진짜 admin)로 include_agent_conversations 요청 시 여전히 정상 통과."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations",
                params={"project_id": str(seeded["project_x_id"]), "include_agent_conversations": "true"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
