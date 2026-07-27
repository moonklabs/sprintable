"""E-SECURITY SEC-S8(story 83ea3d6a) CC: sprints.py 전 엔드포인트 project-scope 미검증 봉쇄
실증(선생님 "sprint org-level=갭" 확定, 까심 전수스윕 후속).

sprints.py 13개 엔드포인트 전부 org-scope만이고 caller의 project 접근권 검증이 어디에도
없었다 — project_a만 grant된 caller가 org 내 project_b의 sprint를 조회/생성/수정/삭제/
활성화/종료/kickoff/summary/checkin/transition 전부 가능했다. resolve_member(project_id=)/
has_project_access SSOT로 봉인 — 이 파일은 각 엔드포인트가 실제로 cross-project 요청을
차단(404/403)하고 same-project는 정상 동작함을 실 Postgres로 검증한다."""
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


async def _seed_base(session):
    """org(project_a, project_b) + human_a(project_a에만 명시 grant)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"h-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "human_user_id": human_user_id,
    }


async def _seed_sprint(session, org_id, project_id, status="planning"):
    from app.models.pm import Sprint
    sprint = Sprint(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Sprint", status=status, duration=14)
    session.add(sprint)
    await session.commit()
    return sprint.id


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


# ── get_sprint ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_sprint_cross_project_blocked_same_project_ok():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"])
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp_b = await client.get(f"/api/v2/sprints/{sprint_b}")
            assert resp_b.status_code == 404, resp_b.text
            resp_a = await client.get(f"/api/v2/sprints/{sprint_a}")
            assert resp_a.status_code == 200, resp_a.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── list_sprints ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_sprints_no_project_id_filters_to_accessible_only():
    """project_id 미지정 시 org 전체가 아니라 accessible project로만 필터(완전봉인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"])
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/sprints")
            assert resp.status_code == 200, resp.text
            ids = {item["id"] for item in resp.json()}
            assert str(sprint_a) in ids
            assert str(sprint_b) not in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_sprints_project_id_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/sprints", params={"project_id": str(seeded["project_b_id"])})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── create_sprint ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_sprint_cross_project_blocked_no_row():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/sprints", json={
                "project_id": str(seeded["project_b_id"]), "org_id": str(seeded["org_id"]),
                "title": "Injected Sprint",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            rows = (await s.execute(
                select(Sprint).where(Sprint.project_id == seeded["project_b_id"])
            )).scalars().all()
            assert rows == [], "무권한 project에 sprint가 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── delete_sprint ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_sprint_cross_project_blocked_no_mutation():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/sprints/{sprint_b}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(select(Sprint).where(Sprint.id == sprint_b))).scalar_one_or_none()
            assert reloaded is not None, "무권한 project sprint가 삭제되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── kickoff / summary / checkin (읽기+알림 계열) ────────────────────────────────

@pytest.mark.anyio
async def test_kickoff_sprint_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_b}/kickoff", json={})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_sprint_summary_cross_project_blocked_same_project_ok():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"])
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp_b = await client.get(f"/api/v2/sprints/{sprint_b}/summary")
            assert resp_b.status_code == 404, resp_b.text
            resp_a = await client.get(f"/api/v2/sprints/{sprint_a}/summary")
            assert resp_a.status_code == 200, resp_a.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_checkin_sprint_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{sprint_b}/checkin", params={"date": "2026-07-11"})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── update_sprint (PATCH) ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_sprint_cross_project_blocked_no_mutation():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/sprints/{sprint_b}", json={"title": "Hijacked"})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(select(Sprint).where(Sprint.id == sprint_b))).scalar_one()
            assert reloaded.title == "Sprint", "무권한 project sprint 제목이 변조되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── activate / close / transition ────────────────────────────────────────────

@pytest.mark.anyio
async def test_activate_sprint_cross_project_blocked_no_mutation():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_b}/activate")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(select(Sprint).where(Sprint.id == sprint_b))).scalar_one()
            assert reloaded.status == "planning", "무권한 project sprint가 활성화되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_transition_sprint_cross_project_blocked_no_mutation():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_b}/transition", json={"status": "active"})
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(select(Sprint).where(Sprint.id == sprint_b))).scalar_one()
            assert reloaded.status == "planning", "무권한 project sprint가 전이되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── list_sprint_hypotheses (read-쌍둥이 발견즉시수정) ────────────────────────────

@pytest.mark.anyio
async def test_list_sprint_hypotheses_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"])

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/sprints/{sprint_b}/hypotheses")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
