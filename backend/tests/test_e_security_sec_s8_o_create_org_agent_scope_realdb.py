"""E-SECURITY SEC-S8(story 83ea3d6a) O: create_org_agent 에이전트-분기 grant-scope 미검증 봉쇄
실증.

`has_project_role`이 caller agent의 anchor project(actor.project_id) 하나만 검사해, P1에만
admin인 에이전트가 scope_mode='projects'로 P2(본인 무권한 project)나 scope_mode='org'로 org
전체에 새 에이전트+API키를 찍어낼 수 있었다(까심 실HTTP 2단계 재현, PR#1557부터 존재하던 갭)."""
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
    """org(project_p1, project_p2) + agent(project_p1에만 role=admin grant)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_p1 = Project(id=uuid.uuid4(), org_id=org.id, name="Project P1")
    project_p2 = Project(id=uuid.uuid4(), org_id=org.id, name="Project P2")
    session.add_all([project_p1, project_p2])
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="agent-p1-admin", is_active=True)
    session.add(agent)
    await session.commit()
    agent_id = agent.id
    # P1에만 admin grant — P2는 무권한.
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_p1.id, member_id=agent_id, permission="granted", role="admin",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_p1_id": project_p1.id, "project_p2_id": project_p2.id,
        "agent_id": agent_id,
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
async def test_p1_admin_agent_can_create_agent_scoped_to_p1():
    """회귀 0: P1에서 admin인 에이전트는 P1로 scope_mode='projects' 새 에이전트 생성 가능."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agents",
                json={
                    "name": "LegitChild", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_p1_id"])],
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_p1_admin_agent_cannot_create_agent_scoped_to_p2():
    """O 재현: P1에서만 admin인 에이전트가 P2(무권한)로 scope_mode='projects' 시도 → 403
    (기존엔 actor.project_id=P1만 검사해 통과·P2에 admin 에이전트+API키 찍힘)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agents",
                json={
                    "name": "RogueChildP2", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_p2_id"])],
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_p1_admin_agent_cannot_create_org_wide_agent():
    """O 재현(scope_mode='org' 축): P1에서만 admin인 에이전트가 scope_mode='org'(전 프로젝트
    grant, P2 포함) 시도 → 403(P2에 admin 아니므로 전체 요청 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/agents",
                json={"name": "RogueOrgWide", "scope_mode": "org"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
