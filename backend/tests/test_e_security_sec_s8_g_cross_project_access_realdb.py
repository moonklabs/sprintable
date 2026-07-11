"""E-SECURITY SEC-S8(story 83ea3d6a) G: story/task/meeting/visual-artifacts 개별-ID 접근 +
visual-artifacts list의 project-scope 미검증 봉쇄 실증.

근본: 개별-ID GET/PATCH 계열이 org-scope만 있고 project 접근권(has_project_access) 미검증이라
같은 org 내 다른 project의(자신은 접근권 없는) member가 story/task/meeting id만 알면 조회/수정
가능했다. visual-artifacts list는 project_id 필터 자체가 없어 파라미터 없는 호출이 org 전체를
반환했다(미르코 라이브 실측 N)."""
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
    """org(project_a, project_b) + story_a/task_a(project_a) + meeting_a(project_a) +
    visual_artifact_a(project_a) + human_a(project_a에만 명시 grant, project_b 접근권 없음)."""
    from sqlalchemy import text
    from app.models.organization import Organization
    from app.models.pm import Story, Task
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.visual_artifact import VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A")
    session.add(story_a)
    await session.commit()

    task_a = Task(id=uuid.uuid4(), org_id=org.id, story_id=story_a.id, title="Task A")
    session.add(task_a)
    await session.commit()

    meeting_a_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO meetings (id, project_id, title, meeting_type, participants, decisions, action_items) "
            "VALUES (:id, :pid, :title, 'general'::meeting_type, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)"
        ),
        {"id": meeting_a_id, "pid": project_a.id, "title": "Meeting A"},
    )
    await session.commit()

    artifact_a = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Artifact A",
        source="created", latest_version_number=1, created_by=uuid.uuid4(),
    )
    artifact_b = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Artifact B",
        source="created", latest_version_number=1, created_by=uuid.uuid4(),
    )
    session.add_all([artifact_a, artifact_b])
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
        "story_a_id": story_a.id, "task_a_id": task_a.id, "meeting_a_id": meeting_a_id,
        "artifact_a_id": artifact_a.id, "artifact_b_id": artifact_b.id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id=None):
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

    meta = {"org_id": str(org_id)}
    if project_id is not None:
        meta["project_id"] = str(project_id)

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": meta})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_project_a_human_can_get_own_project_task():
    """회귀 0: project_a grant 보유 휴먼은 project_a의 task 정상 조회."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks/{seeded['task_a_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_a_human_can_get_own_project_story():
    """회귀 0: project_a grant 보유 휴먼은 project_a의 story 정상 조회."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{seeded['story_a_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_a_human_can_get_own_project_meeting():
    """회귀 0: project_a grant 보유 휴먼은 project_a의 meeting 정상 조회(project_id는 JWT context)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/meetings/{seeded['meeting_a_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_get_other_project_meeting():
    """G 재현: project_a에만 grant된 휴먼이 project_b(query param override)로 meeting 접근 시도
    → 403(기존엔 _get_repo가 project_id를 검증 없이 그대로 받아들여 열람 가능)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        # JWT context는 project_a지만 query param으로 project_b를 명시 override 시도.
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/meetings/{uuid.uuid4()}?project_id={seeded['project_b_id']}"
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_visual_artifacts_list_scoped_to_own_project_only():
    """N 재현: visual-artifacts list가 project_id 필터 없이 org 전체를 반환하던 갭 —
    이제 caller의 JWT project_id로 스코프돼 다른 project(project_b)의 artifact가 안 섞인다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/visual-artifacts")
            assert resp.status_code == 200, resp.text
            items = resp.json()["data"]
            ids = {item["id"] for item in items}
            assert str(seeded["artifact_a_id"]) in ids
            assert str(seeded["artifact_b_id"]) not in ids, "다른 project(B) artifact가 섞이면 안 됨"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
