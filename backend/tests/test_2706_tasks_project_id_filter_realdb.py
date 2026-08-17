"""story #2706 — GET /api/v2/tasks에 project_id 필터 신설(#2697 클래스, story #2428 PR③ 작업
중 디디 부수발견). org-wide(story_id 미지정) 분기가 project_id 필터 자체가 없어 accessible한
전 프로젝트 task가 한 응답에 섞여 나갔다 — project_id 지정 시 require_project_access(#2697
SSOT, 새 판정 발명 0)로 접근권 검증 後 그 프로젝트로만 좁힌다. 미지정 시 기존 org-wide 동작
회귀 0.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

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

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_two_projects_with_tasks(session):
    """org에 project A(caller 접근권 O)·project B(caller 접근권 X) — 각각 story+task 2개씩."""
    from app.models.organization import Organization
    from app.models.pm import Story, Task
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org2706", slug=f"org2706-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add(project_a)
    session.add(project_b)
    await session.commit()

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="SA")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="SB")
    session.add(story_a)
    session.add(story_b)
    await session.commit()

    base = datetime.now(timezone.utc)
    for i in range(2):
        session.add(Task(
            id=uuid.uuid4(), org_id=org.id, story_id=story_a.id, title=f"a{i}",
            created_at=base - timedelta(seconds=10 - i),
        ))
    for i in range(2):
        session.add(Task(
            id=uuid.uuid4(), org_id=org.id, story_id=story_b.id, title=f"b{i}",
            created_at=base - timedelta(seconds=10 - i),
        ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    # caller는 project A만 접근권 — project B는 미부여(negative 케이스).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "caller_id": caller_id,
    }


@pytest.mark.anyio
async def test_project_id_specified_scopes_to_that_project_only():
    """AC1 — project_id 지정 시 그 프로젝트 tasks만(count도 같은 필터)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects_with_tasks(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks", params={"project_id": str(seeded["project_a_id"])})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert {t["title"] for t in body} == {"a0", "a1"}
            assert resp.headers["x-total-count"] == "2"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_without_access_is_404():
    """AC3 — 접근 없는 project_id는 404(#2697 require_project_access 판정 재사용)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects_with_tasks(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks", params={"project_id": str(seeded["project_b_id"])})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_unspecified_keeps_org_wide_behavior_no_regression():
    """AC2 — 미지정 시 기존 org-wide 동작 유지(caller가 접근권 가진 project만이지만 project_id
    자체를 지정 안 했을 때는 project A의 task만 옴 — caller가 B엔 접근권이 없으므로 org-wide
    이지만 실질적으로 A만 보이는 게 기존 동작 그대로임을 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects_with_tasks(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert {t["title"] for t in body} == {"a0", "a1"}
            assert resp.headers["x-total-count"] == "2"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
