"""story #2262 PR②(칩 상태 배치조회) — epic/task/doc/artifact에도 story의 `?ids=` 배치 앵커
조회 패턴을 미러링. 미르코 FE가 타입당 1회 배치조회로 칩을 채우려면 이 넷에도 story처럼
`?ids=`가 필요하다(hypothesis/evidence는 단건 fetch조차 의도적으로 없어 이번 범위 제외).

각 엔드포인트 계약(story list_stories ids=와 동일):
  - comma-separated UUID, 잘못된 값은 422
  - 빈 배열이면 200 []
  - 200건 초과는 422(과대 IN 방어)
  - org 소속이어도 caller가 접근 못 하는 project의 항목은 조용히 필터링(응답에 없음, 에러 아님)
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id, name="Human"):
    """caller — project_id 하나에만 ProjectAccess grant(member role, admin/owner 우회 없음)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_goal(session, org_id, project_id, title="Goal"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="active")
    session.add(goal)
    await session.commit()
    return goal


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story


async def _make_task(session, org_id, story_id, title="Task"):
    from app.models.pm import Task
    task = Task(id=uuid.uuid4(), org_id=org_id, story_id=story_id, title=title)
    session.add(task)
    await session.commit()
    return task


async def _make_doc(session, org_id, project_id, title="Doc", slug=None):
    from app.models.doc import Doc
    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        slug=slug or f"doc-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()
    return doc


async def _make_artifact(session, org_id, project_id, title="Artifact"):
    from app.models.visual_artifact import VisualArtifact
    artifact = VisualArtifact(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(artifact)
    await session.commit()
    return artifact


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id, project_id=None):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    claims = {"org_id": str(org_id)}
    if project_id is not None:
        claims["project_id"] = str(project_id)

    async def _auth():
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": claims})

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _two_project_fixture(session):
    """org 하나 + project 둘. caller는 project A에만 접근권(ProjectAccess) — project B는
    같은 org 소속이라도 caller에게 안 보여야 한다(IDOR 회귀 가드)."""
    org = await _make_org(session)
    project_a = await _make_project(session, org.id, "A")
    project_b = await _make_project(session, org.id, "B")
    caller_id, caller_user_id = await _make_human_member(session, org.id, project_a.id)
    return {
        "org_id": org.id, "project_a": project_a.id, "project_b": project_b.id,
        "caller_id": caller_id, "caller_user_id": caller_user_id,
    }


@pytest.mark.anyio
async def test_goals_ids_returns_set_and_excludes_inaccessible_project_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _two_project_fixture(s)
            goal_a = await _make_goal(s, f["org_id"], f["project_a"], "Goal A")
            goal_b = await _make_goal(s, f["org_id"], f["project_b"], "Goal B")

        await _setup_app_human(app, Session, f["caller_user_id"], f["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/goals?ids={goal_a.id},{goal_b.id}")
            assert resp.status_code == 200, resp.text
            ids = {row["id"] for row in resp.json()}
            assert ids == {str(goal_a.id)}, "접근권 없는 project B의 goal이 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_goals_ids_empty_and_invalid_and_too_many_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _two_project_fixture(s)

        await _setup_app_human(app, Session, f["caller_user_id"], f["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/goals?ids=")
            assert resp.status_code == 200
            assert resp.json() == []

            resp = await client.get("/api/v2/goals?ids=not-a-uuid")
            assert resp.status_code == 422

            too_many = ",".join(str(uuid.uuid4()) for _ in range(201))
            resp = await client.get(f"/api/v2/goals?ids={too_many}")
            assert resp.status_code == 422
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_tasks_ids_returns_set_and_excludes_inaccessible_project_realdb():
    """Task는 project_id 컬럼이 없어(story_id JOIN) 접근권 스코프가 story 경유로 도는지가
    핵심 — story_a/story_b가 각각 project_a/project_b 소속인 두 task로 검증."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _two_project_fixture(s)
            story_a = await _make_story(s, f["org_id"], f["project_a"], "Story A")
            story_b = await _make_story(s, f["org_id"], f["project_b"], "Story B")
            task_a = await _make_task(s, f["org_id"], story_a.id, "Task A")
            task_b = await _make_task(s, f["org_id"], story_b.id, "Task B")

        await _setup_app_human(app, Session, f["caller_user_id"], f["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks?ids={task_a.id},{task_b.id}")
            assert resp.status_code == 200, resp.text
            ids = {row["id"] for row in resp.json()}
            assert ids == {str(task_a.id)}, "접근권 없는 project B의 story에 달린 task가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_docs_ids_returns_set_and_excludes_inaccessible_project_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _two_project_fixture(s)
            doc_a = await _make_doc(s, f["org_id"], f["project_a"], "Doc A")
            doc_b = await _make_doc(s, f["org_id"], f["project_b"], "Doc B")

        await _setup_app_human(app, Session, f["caller_user_id"], f["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/docs?ids={doc_a.id},{doc_b.id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {row["id"] for row in body["data"]}
            assert ids == {str(doc_a.id)}, "접근권 없는 project B의 doc이 새면 안 된다"
            assert body["meta"] == {"has_more": False, "next_cursor": None}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_artifacts_ids_returns_set_and_excludes_other_project_realdb():
    """visual_artifacts는 caller 컨텍스트의 project_id 하나로만 스코프(SEC-S8 G 기존 계약) —
    ids=가 그 스코프를 우회해 다른 project artifact를 새게 하면 안 된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            f = await _two_project_fixture(s)
            artifact_a = await _make_artifact(s, f["org_id"], f["project_a"], "Artifact A")
            artifact_b = await _make_artifact(s, f["org_id"], f["project_b"], "Artifact B")

        await _setup_app_human(
            app, Session, f["caller_user_id"], f["org_id"], project_id=f["project_a"],
        )
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/visual-artifacts?ids={artifact_a.id},{artifact_b.id}"
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {row["id"] for row in body["data"]}
            assert ids == {str(artifact_a.id)}, "caller의 project_id 밖 artifact가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
