"""E-SECURITY SEC HIGH baseline paydown round6 — #2050 ratchet _KNOWN_DEBT_ALLOWLIST HIGH
5건 중 tasks.list_tasks 상환.

근본: 이 엔드포인트엔 project_id 파라미터 자체가 없고 story_id가 유일한 project-환원
파라미터라, story_id만 알면(project_id 불필요) 접근권 없는 project의 task title/status/
assignee가 노출됐다(round5 sprint_id류 "필터 파라미터 우회" 클래스와 동형 — 다만 이번엔
project_id 가드를 우회하는 게 아니라 애초에 project_id 파라미터가 없어 story_id 자체가
유일 벡터). 기존 개별-ID GET(_assert_task_project_access, SEC-S8 G)과 동일 헬퍼 재사용해
story_id→project_id 해소 후 has_project_access 검증으로 봉인."""
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
    """org(project_a, project_b) + story_b(project_b) + task_b(story_b 소속,
    title="TOP SECRET B TASK") + human_a(project_a에만 명시 grant, project_b 접근권 없음)."""
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

    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B")
    session.add(story_b)
    await session.commit()

    task_b = Task(id=uuid.uuid4(), org_id=org.id, story_id=story_b.id, title="TOP SECRET B TASK")
    session.add(task_b)
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    # project_a에만 명시 grant — project_b 접근권 없음(org owner/admin도 아님).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "story_b_id": story_b.id, "task_b_id": task_b.id, "human_user_id": human_user_id,
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_tasks_via_other_project_story_id():
    """봉인 실증: project_a에만 grant된 휴먼이 project_b story_id(project_id 파라미터
    없이!)로 task 조회 시도 → 403(기존엔 story_id→project 접근권 검증 0이라 200+유출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks?story_id={seeded['story_b_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_tasks_via_other_project_story_id_and_assignee_combo():
    """봉인 실증(복합 파라미터): story_id + assignee_id를 함께 넘겨도(assignee_id로
    무해하게 보이는 조합) story_id 벡터 자체가 여전히 차단된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/tasks?story_id={seeded['story_b_id']}&assignee_id={uuid.uuid4()}"
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_story_id_returns_403_not_leak():
    """엣지: 존재하지 않는 story_id도 403(존재여부 자체를 흘리지 않음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks?story_id={uuid.uuid4()}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
