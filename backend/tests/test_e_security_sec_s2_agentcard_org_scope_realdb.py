"""E-SECURITY SEC-S2(story 48ff642a): AgentCard 발견 authed+org-scoping — 실 Postgres 검증."""
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


async def _seed_agent(session, org, project_name="P"):
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    project = Project(id=uuid.uuid4(), org_id=org.id, name=project_name)
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name=f"Agent-{project_name}", is_active=True)
    session.add_all([project, agent])
    await session.commit()
    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)
    await session.commit()
    return agent.id


async def _seed_two_orgs(session):
    from app.models.organization import Organization

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    caller_id = await _seed_agent(session, org_a, "OrgA-Caller")
    target_same_org_id = await _seed_agent(session, org_a, "OrgA-Target")
    target_other_org_id = await _seed_agent(session, org_b, "OrgB-Target")

    return org_a.id, org_b.id, caller_id, target_same_org_id, target_other_org_id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_agent_card_unauthenticated_now_rejected():
    """auth override 없이 호출 시 401/403(실 get_current_user가 걸림) — unauth 시대 종료 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, org_b_id, caller_id, same_org_id, other_org_id = await _seed_two_orgs(s)

        # get_db만 override, auth는 실 의존성 그대로(토큰 없이 호출 → 401 기대)
        async def _db():
            async with Session() as s:
                yield s

        from app.dependencies.database import get_db
        app.dependency_overrides[get_db] = _db

        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/a2a/members/{same_org_id}/agent-card.json")
            assert resp.status_code in (401, 403), resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_org_discovery_still_free():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, org_b_id, caller_id, same_org_id, other_org_id = await _seed_two_orgs(s)

        await _setup_app(app, Session, caller_id, org_a_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/a2a/members/{same_org_id}/agent-card.json")
            assert resp.status_code == 200, resp.text
            assert resp.json()["name"] == "Agent-OrgA-Target"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_discovery_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a_id, org_b_id, caller_id, same_org_id, other_org_id = await _seed_two_orgs(s)

        await _setup_app(app, Session, caller_id, org_a_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/a2a/members/{other_org_id}/agent-card.json")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
