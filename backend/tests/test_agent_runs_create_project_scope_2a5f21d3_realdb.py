"""2a5f21d3 — create_agent_run 모델↔DB 드리프트 회수 + project_id IDOR 가드, 실 Postgres 검증.

드리프트: duration_ms(DB GENERATED ALWAYS vs 모델 plain writable)+project_id(DB NOT NULL vs
모델 nullable=True)로 agent_runs 생성이 전건 500(GeneratedAlwaysError/NotNullViolation)이었다.
fix: 모델 duration_ms=Computed(insert emit 방지)+project_id=NOT NULL, CreateAgentRun에 project_id
필수 추가, duration_ms 입력 제거. project_id는 신규 mutation 인가 표면이라 resource-actual
has_project_access로 가드(body-claimed 금지·round1~9 규율).

realdb 2방향: (a)정당 project_id→201(GeneratedAlways/NotNull 둘 다 해소·duration_ms는 DB 계산)
(b)cross-project/nonexistent project_id→403/404(IDOR 차단·비-동어반복).
"""
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
    """org(project_a, project_b) + agent_a(project_a grant·team_members 뷰 진입) +
    caller(휴먼·project_a에만 grant·project_b 접근권 없음)."""
    from app.models.member import Member
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

    agent_a = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent_a)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, member_id=agent_a.id, permission="granted", role="member",
    ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "agent_a_id": agent_a.id, "caller_id": caller_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_create_with_valid_project_id_returns_201_drift_resolved():
    """정당 project_id(접근권 有) 공급 시 201 — GeneratedAlwaysError(duration_ms)/NotNull
    (project_id) 둘 다 해소. duration_ms는 DB 계산(started/finished_at 없으면 None)."""
    from app.main import app
    from sqlalchemy import text
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_a_id"]),
                "project_id": str(seeded["project_a_id"]),
                "status": "running",
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["agent_id"] == str(seeded["agent_a_id"])
            assert body["duration_ms"] is None  # DB GENERATED — started/finished_at 없어 None
            # 영속 확認: run이 project_a로 실제 생성됐는지 DB 직조회(AgentRunResponse엔 project_id 미노출).
            async with Session() as s2:
                row = (await s2.execute(
                    text("SELECT project_id, duration_ms FROM agent_runs WHERE id = :id"),
                    {"id": body["id"]},
                )).first()
                assert row is not None
                assert str(row[0]) == str(seeded["project_a_id"])
                assert row[1] is None  # duration_ms DB 계산(입력 불가·started/finished 없어 None)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_with_cross_project_id_returns_403_idor_block():
    """비-동어반복 IDOR: project_a grant caller가 접근권 없는 project_b를 body로 넣어 run 생성
    시도 → 403(resource-actual has_project_access 가드). run은 생성되지 않는다."""
    from app.main import app
    from sqlalchemy import text
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_a_id"]),
                "project_id": str(seeded["project_b_id"]),
                "status": "running",
            })
            assert resp.status_code == 403, resp.text
            # run이 실제로 안 생겼는지 확認(가드가 write 앞에서 차단).
            async with Session() as s2:
                cnt = (await s2.execute(
                    text("SELECT count(*) FROM agent_runs WHERE project_id = :p"),
                    {"p": seeded["project_b_id"]},
                )).scalar_one()
                assert cnt == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_with_nonexistent_project_id_returns_404():
    """존재하지 않는 project_id(또는 타org)는 404 — 존재여부 비노출."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_a_id"]),
                "project_id": str(uuid.uuid4()),
                "status": "running",
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_missing_project_id_returns_422():
    """project_id는 이제 필수 — 누락 시 422(계약 강제)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_a_id"]),
                "status": "running",
            })
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
