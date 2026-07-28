"""#2237(READ) — GET /missing·GET /feedback(standups.py get_missing_standups·list_feedback)
project-scope IDOR, 실 PG.

갭: 둘 다 project_id를 쿼리파라미터로 받되 caller 접근권 검증이 없었다(#2200 A급 전수 적출) —
`auth` 파라미터 자체가 없어 caller 식별조차 안 했다(가장 노골적인 형태). 바로 옆 형제
list_standups/list_standup_history는 이미 has_project_access(ratchet round5, #2050)를 쓰고
있었다. 처방: 그 형제와 동일한 has_project_access + 동일 404 "Project not found" 관례.
"""
from __future__ import annotations

import os
import uuid
from datetime import date

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
    """org(project_a[caller grant]·project_b[무접근]) + project_b standup entry(SECRET blockers)
    + project_b에 링크된 feedback(SECRET note)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.standup import StandupEntry, StandupEntryProject, StandupFeedback
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    the_date = date(2026, 7, 11)
    entry_b = StandupEntry(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, sprint_id=None,
        author_id=uuid.uuid4(), date=the_date,
        done="x", plan="y", blockers="SECRET BLOCKER PROJECT B",
    )
    session.add(entry_b)
    await session.commit()
    session.add(StandupEntryProject(id=uuid.uuid4(), org_id=org.id, entry_id=entry_b.id, project_id=project_b.id))
    await session.commit()
    feedback_b = StandupFeedback(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, standup_entry_id=entry_b.id,
        feedback_by_id=uuid.uuid4(), review_type="comment", feedback_text="SECRET FEEDBACK PROJECT B",
    )
    session.add(feedback_b)
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "the_date": the_date, "caller_id": caller_id,
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
async def test_get_missing_standups_own_project_200():
    """회귀0: project_a grant caller가 project_a missing 조회 → 200."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/standups/missing?project_id={seeded['project_a_id']}&date={seeded['the_date'].isoformat()}"
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_missing_standups_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b missing 조회 시도 → 404(수정 前엔 auth 파라미터도 없어 200 통과)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/standups/missing?project_id={seeded['project_b_id']}&date={seeded['the_date'].isoformat()}"
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_feedback_own_project_200():
    """회귀0: project_a grant caller가 project_a feedback 조회(빈 결과여도 200)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/standups/feedback?project_id={seeded['project_a_id']}&date={seeded['the_date'].isoformat()}"
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_feedback_cross_project_blocked_404_no_leak():
    """봉인: 접근권 없는 project_b feedback(SECRET FEEDBACK) 조회 시도 → 404 + 내용 무노출
    (수정 前엔 auth 파라미터도 없어 project_id 필터만으로 200 + SECRET 노출)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/standups/feedback?project_id={seeded['project_b_id']}&date={seeded['the_date'].isoformat()}"
            )
            assert resp.status_code == 404, resp.text
            assert "SECRET FEEDBACK PROJECT B" not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
