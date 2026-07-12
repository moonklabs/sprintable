"""E-SECURITY SEC-S7(story a7dd0431·까심 QA 부수발견 E): agent_personas 생성 org/project 검증 —
타 org agent에 persona 주입(public AgentCard 오염 + default persona collision DoS) 봉쇄 실증.

SEC-S6의 `assert_target_in_caller_org` 공통 가드를 그대로 배선(신설 없음)."""
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


async def _seed_two_orgs(session):
    """Org A caller·Org B agent — E 재현용."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Org B Project")
    session.add_all([project_a, project_b])
    await session.commit()

    agent_a = Member(id=uuid.uuid4(), org_id=org_a.id, type="agent", name="Org A Agent", is_active=True)
    agent_b = Member(id=uuid.uuid4(), org_id=org_b.id, type="agent", name="Org B Agent", is_active=True)
    session.add_all([agent_a, agent_b])
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "agent_a_id": agent_a.id, "agent_b_id": agent_b.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id):
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
            user_id=str(uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_create_persona_cross_org_agent_blocked():
    """까심 E 재현: Org A caller가 Org B agent_id로 persona 생성 시도 → 404(오염 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agent-personas",
                json={"agent_id": str(seeded["agent_b_id"]), "name": "Injected"},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        # persona 미생성 확認
        async with Session() as s:
            from sqlalchemy import select
            from app.models.agent_deployment import AgentPersona
            rows = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == seeded["agent_b_id"])
            )).scalars().all()
            assert len(rows) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_persona_same_org_agent_still_free():
    """회귀 0: Org A caller가 자기 org agent_id로 생성하면 정상 201."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agent-personas",
                json={"agent_id": str(seeded["agent_a_id"]), "name": "Legit"},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_seed_builtin_personas_cross_org_agent_blocked():
    """seed_builtin_personas도 동일 갭·동일 가드로 봉쇄."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/agent-personas/seed?agent_id={seeded['agent_b_id']}",
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_persona_nonexistent_agent_also_404():
    """존재하지 않는 agent_id도 동일 404(존재 비노출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agent-personas",
                json={"agent_id": str(uuid.uuid4()), "name": "Ghost"},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
