"""E-SECURITY fast-follow d3e5ca89 — GET /api/v2/tasks org-wide(story_id 미지정) 분기의
result-level cross-project 누출 봉인, 실 Postgres 검증.

갭: round6(#2072)은 story_id 벡터만 닫았고, story_id 미지정 분기는 org 전체 task를 그대로
반환해 같은 org 안 접근권 없는 project의 task title/assignee_id/status가 열거됐다(result-level
IDOR). fix: caller의 accessible_project_ids_in_org로 스코프(Task엔 project_id가 없어 Story JOIN).

적대 축(비-동어반복): 시크릿 project_b task의 title/assignee_id가 응답 바디에 verbatim
미노출까지 assert. + assignee_id 필터로도 cross-project task를 못 끌어옴을 실증.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_SECRET_TASK_TITLE_B = "SECRET-TASK-B-TITLE"


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
    """org(project_a, project_b):
    - caller(휴먼·org member·project_a에만 grant)
    - owner(휴먼·org owner·grant 없이 org-wide)
    - story_a∈project_a + task_a(title="Task A") / story_b∈project_b + task_b(title=시크릿·시크릿 assignee)
    """
    from app.models.organization import Organization
    from app.models.pm import Story, Task
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

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B")
    session.add_all([story_a, story_b])
    await session.commit()

    secret_assignee_id = uuid.uuid4()
    task_a = Task(id=uuid.uuid4(), org_id=org.id, story_id=story_a.id, title="Task A", status="todo")
    task_b = Task(
        id=uuid.uuid4(), org_id=org.id, story_id=story_b.id, title=_SECRET_TASK_TITLE_B,
        status="in-progress", assignee_id=secret_assignee_id,
    )
    session.add_all([task_a, task_b])
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

    owner_id = uuid.uuid4()
    owner = User(id=owner_id, email=f"owner-{owner_id.hex[:8]}@test.com", hashed_password="x")
    session.add(owner)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_id, role="owner"))
    await session.commit()

    # 접근권 전무 caller(다른 org member·grant 0)
    noaccess_id = uuid.uuid4()
    noaccess = User(id=noaccess_id, email=f"noacc-{noaccess_id.hex[:8]}@test.com", hashed_password="x")
    session.add(noaccess)
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=noaccess_id, role="member"))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "story_a_id": story_a.id, "story_b_id": story_b.id,
        "task_a_id": task_a.id, "task_b_id": task_b.id, "secret_assignee_id": secret_assignee_id,
        "caller_id": caller_id, "owner_id": owner_id, "noaccess_id": noaccess_id,
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
async def test_org_wide_list_scoped_to_accessible_projects_no_leak():
    """봉인(비-동어반복): project_a grant caller가 story_id 없이 /tasks 조회 → task_a만.
    project_b 시크릿 task의 title/assignee_id가 바디에 verbatim 미노출까지 assert."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks")
            assert resp.status_code == 200, resp.text
            ids = {t["id"] for t in resp.json()}
            assert ids == {str(seeded["task_a_id"])}
            assert _SECRET_TASK_TITLE_B not in resp.text, "cross-project task title 유출"
            assert str(seeded["secret_assignee_id"]) not in resp.text, "cross-project assignee_id 유출"
            assert str(seeded["task_b_id"]) not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_owner_sees_all_projects_org_wide_unchanged():
    """회귀0(over-block 방지): org owner는 grant 없이 org-wide 접근이라 /tasks에서 두 project
    task를 모두 본다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["owner_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks")
            assert resp.status_code == 200, resp.text
            ids = {t["id"] for t in resp.json()}
            assert ids == {str(seeded["task_a_id"]), str(seeded["task_b_id"])}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_access_caller_gets_empty():
    """접근권 0 caller(grant 없는 org member)는 org-wide /tasks에서 빈 리스트."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["noaccess_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks")
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
            assert _SECRET_TASK_TITLE_B not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_assignee_filter_cannot_exfiltrate_cross_project():
    """적대 축: project_a caller가 project_b 시크릿 assignee_id로 필터해도 0건 — assignee 필터로
    cross-project task를 끌어올 수 없다(스코프가 필터보다 우선)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks?assignee_id={seeded['secret_assignee_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
            assert _SECRET_TASK_TITLE_B not in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_id_branch_regression_unchanged():
    """회귀0: story_id 지정 분기는 round6 가드 그대로 — 접근권 있는 story_a는 200(task_a),
    접근권 없는 story_b는 403."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            ok = await client.get(f"/api/v2/tasks?story_id={seeded['story_a_id']}")
            assert ok.status_code == 200, ok.text
            assert {t["id"] for t in ok.json()} == {str(seeded["task_a_id"])}

            blocked = await client.get(f"/api/v2/tasks?story_id={seeded['story_b_id']}")
            assert blocked.status_code == 403, blocked.text
            assert _SECRET_TASK_TITLE_B not in blocked.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
