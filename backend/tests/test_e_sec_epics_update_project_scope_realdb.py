"""E-SECURITY 스캐너 라운드1(#1·story 5285888c) — epics:update_epic PATH_ID project-scope IDOR, 실 PG.

갭: PATCH /epics/{id}(update_epic)가 repo org-scope만이라 접근권 없는 same-org 다른 project의
epic을 id만으로 title/goal/전략까지 덮어쓸 수 있었다(PATH_ID 뮤테이션 project-scope IDOR·스캐너
_KNOWN_DEBT #1). fix: resolved-resource(현 epic의 실 project_id)에 has_project_access 사전검증
(404·존재 비노출·body-claimed 금지·EpicUpdate엔 project_id 필드 없어 이동 경로 부재).
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
    """org(project_a[caller grant]·project_b[무접근]) + epic_a(project_a)·epic_b(project_b)."""
    from app.models.organization import Organization
    from app.models.pm import Epic
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
    epic_a = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Epic A")
    epic_b = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Epic B orig")
    session.add_all([epic_a, epic_b])
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

    return {"org_id": org.id, "epic_a_id": epic_a.id, "epic_b_id": epic_b.id, "caller_id": caller_id}


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


async def _epic_title(Session, epic_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT title FROM epics WHERE id = :i"), {"i": epic_id}
        )).scalar_one()


@pytest.mark.anyio
async def test_update_epic_own_project_200():
    """회귀0: project_a grant caller가 project_a epic title 수정 → 200 + 반영."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/epics/{seeded['epic_a_id']}", json={"title": "Epic A updated"})
            assert resp.status_code == 200, resp.text
            assert await _epic_title(Session, seeded["epic_a_id"]) == "Epic A updated"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_epic_cross_project_blocked_404_not_modified():
    """봉인(PATH_ID 뮤테이션 IDOR·비-동어반복): 접근권 없는 project_b epic을 id로 덮어쓰기 시도 →
    404 + **미변경 직조회**(epic_b title 원본 유지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/epics/{seeded['epic_b_id']}", json={"title": "HACKED", "objective": "pwned"},
            )
            assert resp.status_code == 404, resp.text
            assert await _epic_title(Session, seeded["epic_b_id"]) == "Epic B orig", "cross-project epic이 변경됨(IDOR)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
