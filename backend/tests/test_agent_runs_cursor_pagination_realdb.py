"""agent-runs cursor 페이지네이션 500 회귀 — 까심 부수발견(HIGH). GET /api/v2/agent-runs가
cursor(ISO created_at 문자열)를 timestamptz 컬럼에 varchar로 직비교해 asyncpg가 캐스팅 실패
→ 500. FE load-more가 라이브로 도달하는 경로. cursor를 datetime으로 파싱해 timestamptz 바인딩.

realdb 재현 필수(CI SQLite/mock 사각 — asyncpg 배포 동작만 잡힘). 500→200 실증 + 페이지 경계
정확성 + 잘못된 cursor 400.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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
    """org(project_a)+caller(grant)+agent_a(grant)+run_new/run_old(created_at 명시 시간차).
    AgentRun은 raw SQL(duration_ms GENERATED ALWAYS)·created_at 명시로 cursor 경계 제어."""
    from sqlalchemy import text

    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    session.add(project_a)
    await session.commit()
    agent_a = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent_a)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, member_id=agent_a.id, permission="granted", role="member",
    ))
    await session.commit()

    run_new_id, run_old_id = uuid.uuid4(), uuid.uuid4()
    _ins = text(
        "INSERT INTO agent_runs (id, org_id, project_id, agent_id, trigger, status, created_at) "
        "VALUES (:id, :org_id, :project_id, :agent_id, 'manual', 'completed', :created_at)"
    )
    # run_new: 2026-01-02, run_old: 2026-01-01 — cursor=run_new.created_at 이면 run_old만 나와야.
    # created_at은 datetime 객체로 바인딩(timestamptz 컬럼·문자열 바인딩 시 asyncpg DataError).
    await session.execute(_ins, {"id": run_new_id, "org_id": org.id, "project_id": project_a.id,
                                 "agent_id": agent_a.id,
                                 "created_at": datetime(2026, 1, 2, tzinfo=timezone.utc)})
    await session.execute(_ins, {"id": run_old_id, "org_id": org.id, "project_id": project_a.id,
                                 "agent_id": agent_a.id,
                                 "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc)})
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="owner")
    session.add(caller_om)
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id,
        "run_new_id": run_new_id, "run_old_id": run_old_id, "caller_id": caller_id,
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
async def test_cursor_pagination_returns_200_not_500():
    """회귀(500→200): ISO created_at cursor로 다음 페이지 조회 시 500 없이 200 + cursor보다
    이전 run만 반환(경계 정확성). 기존엔 timestamptz<varchar 캐스팅 실패로 500."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            cursor = "2026-01-02T00:00:00+00:00"  # run_new.created_at
            # params=로 전달해 '+' 오프셋이 %2B로 인코딩되게 한다(쿼리스트링서 raw '+'=space).
            resp = await client.get(
                "/api/v2/agent-runs",
                params={"project_id": str(seeded["project_a_id"]), "cursor": cursor},
            )
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_old_id"])}, "cursor 경계 부정확(run_new가 새면 안 됨)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_cursor_returns_all_ordered_desc():
    """회귀0: cursor 없으면 전체 run을 created_at desc로 반환(run_new 먼저)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            ids = [r["id"] for r in resp.json()]
            assert ids == [str(seeded["run_new_id"]), str(seeded["run_old_id"])]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_cursor_returns_400_not_500():
    """잘못된 cursor(비-ISO)는 400 — 파싱 실패가 500이나 조용한 무시로 새지 않는다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_a_id']}&cursor=not-a-date")
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
