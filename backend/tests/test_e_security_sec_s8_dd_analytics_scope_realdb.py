"""E-SECURITY SEC-S8(story 83ea3d6a) DD: analytics burndown/velocity cross-org IDOR + 전
analytics 엔드포인트 project-scope 봉쇄 실증(까심 라이브확定, CRITICAL).

- get_burndown/get_sprint_velocity: 다른 org_repo 메소드는 전부 org_id를 필터하는데 이 둘만
  누락돼 완전 무관 org가 sprint UUID만 알면 velocity/status를 그대로 열람할 수 있었다.
- 이왕 여는 김에(PO 결) analytics.py 9개 엔드포인트 전부에 has_project_access를 추가해
  same-org cross-project 노출까지 봉인(오늘 R~CC와 동형 근본)."""
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
    """org_a(project_a, sprint_a, human_a=project_a grant) + org_b(project_b, sprint_b)."""
    from app.models.organization import Organization
    from app.models.pm import Sprint
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Project B (SECRET)")
    session.add_all([project_a, project_b])
    await session.commit()

    sprint_a = Sprint(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Sprint A", status="active", duration=14, velocity=10)
    sprint_b = Sprint(id=uuid.uuid4(), org_id=org_b.id, project_id=project_b.id, title="SECRET SPRINT", status="active", duration=14, velocity=99)
    session.add_all([sprint_a, sprint_b])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"h-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org_a.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "project_b_id": project_b.id,
        "sprint_a_id": sprint_a.id, "sprint_b_id": sprint_b.id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ── DD: cross-org (원 취약점) ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_burndown_cross_org_blocked_secret_not_leaked():
    """org_a human이 org_b의 sprint UUID로 burndown 조회 → 404, SECRET 미노출."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{seeded['sprint_b_id']}/burndown")
            assert resp.status_code == 404, resp.text
            assert "SECRET" not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_velocity_cross_org_blocked_secret_not_leaked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{seeded['sprint_b_id']}/velocity")
            assert resp.status_code == 404, resp.text
            assert "SECRET" not in resp.text
            assert "99" not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_burndown_same_org_same_project_still_works():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{seeded['sprint_a_id']}/burndown")
            assert resp.status_code == 200, resp.text
            assert resp.json()["sprint"]["title"] == "Sprint A"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── DD 후속: same-org cross-project (project-scope 하드닝) ──────────────────────

@pytest.mark.anyio
async def test_burndown_same_org_cross_project_blocked():
    """org_a human이 project_a에만 grant 있는데, 같은 org 내 project_b sprint를 만들어 조회 시도."""
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)
            from app.models.project import Project
            project_c = Project(id=uuid.uuid4(), org_id=seeded["org_a_id"], name="Project C")
            s.add(project_c)
            await s.commit()
            sprint_c = Sprint(id=uuid.uuid4(), org_id=seeded["org_a_id"], project_id=project_c.id, title="Sprint C", status="active", duration=14, velocity=5)
            s.add(sprint_c)
            await s.commit()
            sprint_c_id = sprint_c.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{sprint_c_id}/burndown")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_overview_same_org_cross_project_blocked_same_project_ok():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_orgs(s)
            from app.models.project import Project
            project_c = Project(id=uuid.uuid4(), org_id=seeded["org_a_id"], name="Project C")
            s.add(project_c)
            await s.commit()
            project_c_id = project_c.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_a_id"])
        client = _client_for(app)
        try:
            resp_c = await client.get("/api/v2/analytics/overview", params={"project_id": str(project_c_id)})
            assert resp_c.status_code == 404, resp_c.text
            resp_a = await client.get("/api/v2/analytics/overview", params={"project_id": str(seeded["project_a_id"])})
            assert resp_a.status_code == 200, resp_a.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
