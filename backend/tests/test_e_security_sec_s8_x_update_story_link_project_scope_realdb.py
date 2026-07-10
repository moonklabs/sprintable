"""E-SECURITY SEC-S8(story 83ea3d6a) X: update_story epic_id/sprint_id/meeting_id 링크의
project-scope 미검증 봉쇄 실증.

T가 create_story의 링크 검증(_assert_story_link_targets_in_project)만 닫고 update_story(PATCH)
경로가 남아있었다 — 같은 org 다른 project의 epic/sprint/meeting으로 기존 story를 재링크할 수
있었다(까심 전수스윕)."""
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
    """org(project_a, project_b) + story_a(project_a) + epic_a/sprint_a/meeting_a(project_a) +
    epic_b/sprint_b/meeting_b(project_b) + human_a(project_a에만 명시 grant)."""
    from sqlalchemy import text
    from app.models.organization import Organization
    from app.models.pm import Epic, Sprint, Story
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
    session.add(story_a)
    await session.commit()

    epic_a = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Epic A")
    epic_b = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Epic B")
    sprint_a = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Sprint A")
    sprint_b = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Sprint B")
    session.add_all([epic_a, epic_b, sprint_a, sprint_b])
    await session.commit()

    meeting_a_id = uuid.uuid4()
    meeting_b_id = uuid.uuid4()
    for mid, pid, title in ((meeting_a_id, project_a.id, "Meeting A"), (meeting_b_id, project_b.id, "Meeting B")):
        await session.execute(
            text(
                "INSERT INTO meetings (id, project_id, title, meeting_type, participants, decisions, action_items) "
                "VALUES (:id, :pid, :title, 'general'::meeting_type, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)"
            ),
            {"id": mid, "pid": pid, "title": title},
        )
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
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
        "org_id": org.id, "project_a_id": project_a.id, "story_a_id": story_a.id,
        "epic_a_id": epic_a.id, "epic_b_id": epic_b.id,
        "sprint_a_id": sprint_a.id, "sprint_b_id": sprint_b.id,
        "meeting_a_id": meeting_a_id, "meeting_b_id": meeting_b_id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id):
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
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_cross_project_epic_relink_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_a_id']}",
                json={"epic_id": str(seeded["epic_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_sprint_relink_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_a_id']}",
                json={"sprint_id": str(seeded["sprint_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_meeting_relink_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_a_id']}",
                json={"meeting_id": str(seeded["meeting_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_project_relink_still_works():
    """회귀 0: same-project epic/sprint/meeting 재링크는 여전히 정상(과차단 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_a_id']}",
                json={
                    "epic_id": str(seeded["epic_a_id"]), "sprint_id": str(seeded["sprint_a_id"]),
                    "meeting_id": str(seeded["meeting_a_id"]),
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["epic_id"] == str(seeded["epic_a_id"])
            assert body["sprint_id"] == str(seeded["sprint_a_id"])
            assert body["meeting_id"] == str(seeded["meeting_a_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unrelated_field_update_without_links_still_works():
    """회귀 0: 링크 필드 미지정 PATCH(예: title만)는 검증 스킵되고 정상."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_a_id']}",
                json={"title": "Renamed"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["title"] == "Renamed"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
