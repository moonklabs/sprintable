"""E-SECURITY SEC-S8(story 83ea3d6a) P: 에이전트 role-rank 격상(mixed-role cross-project) 봉쇄
실증 — create_team_member(AC3) + create_org_agent(자매 갭, fix-on-sight) 둘 다.

`_resolve_actor()`가 team_members 뷰(멀티프로젝트 grant 시 member당 N행)에서 `.first()`로
임의 1행을 뽑아, actor.role이 target project와 무관한 다른 project의 role일 수 있었다.
mixed-role 에이전트(예: P1=owner, P2=admin)가 role 낮은 target(P2)에서도 다른 project(P1)의
높은 role을 빌려와 상위 role 멤버/에이전트를 찍어낼 수 있었다(비결정 row-pick)."""
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
    """org(project_p1, project_p2) + mixed-role agent(P1=owner grant, P2=admin grant)."""
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

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="mixed-role-agent", is_active=True)
    session.add(agent)
    await session.commit()
    agent_id = agent.id
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_p1.id, member_id=agent_id, permission="granted", role="owner"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_p2.id, member_id=agent_id, permission="granted", role="admin"),
    ])
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


# ── create_team_member(P 본체): mixed-role 에이전트가 target project 전용 role로 평가되는지 ──

@pytest.mark.anyio
async def test_mixed_role_agent_cannot_borrow_p1_owner_role_for_p2_target():
    """P 재현: P1=owner·P2=admin인 에이전트가 P2(target)로 role=owner 멤버 생성 시도 → 403
    (기존엔 .first()가 P1 row를 뽑으면 owner>=owner로 통과할 수 있었음·비결정 격상)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_p2_id"]), "org_id": str(seeded["org_id"]),
                    "type": "agent", "name": "RogueOwnerViaP2", "role": "owner",
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mixed_role_agent_can_create_admin_member_at_own_admin_project():
    """회귀 0: P2에서 admin인 에이전트는 P2에 role=admin 멤버는 여전히 생성 가능(과차단 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_p2_id"]), "org_id": str(seeded["org_id"]),
                    "type": "agent", "name": "LegitAdminAtP2", "role": "admin",
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mixed_role_agent_can_create_owner_member_at_own_owner_project():
    """회귀 0: P1에서 owner인 에이전트는 P1 자체에는 role=owner 멤버도 정상 생성(제 project 내 정당 권한)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/team-members",
                json={
                    "project_id": str(seeded["project_p1_id"]), "org_id": str(seeded["org_id"]),
                    "type": "agent", "name": "LegitOwnerAtP1", "role": "owner",
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── create_org_agent(자매 갭, fix-on-sight): 멀티 project_ids 최솟값 rank로 평가되는지 ──

@pytest.mark.anyio
async def test_org_agent_multi_project_owner_blocked_by_weakest_target():
    """자매갭 재현: scope_mode='projects'[P1,P2]로 role=owner 요청 → 403(P2에선 admin뿐이라
    최솟값 rank=admin<owner)."""
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
                    "name": "RogueOwnerMulti", "role": "owner", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_p1_id"]), str(seeded["project_p2_id"])],
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_agent_multi_project_admin_allowed():
    """회귀 0: scope_mode='projects'[P1,P2]로 role=admin 요청 → 201(두 project 다 admin 이상)."""
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
                    "name": "LegitAdminMulti", "role": "admin", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_p1_id"]), str(seeded["project_p2_id"])],
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_agent_single_p1_owner_allowed():
    """회귀 0: scope_mode='projects'[P1]만으로 role=owner 요청 → 201(P1 단독은 owner 정당)."""
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
                    "name": "LegitOwnerP1Only", "role": "owner", "scope_mode": "projects",
                    "project_ids": [str(seeded["project_p1_id"])],
                },
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
