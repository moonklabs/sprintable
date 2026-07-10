"""E-SECURITY SEC-S3(story 90cd7e57): delete_story project 인가 + create_conversation
participant org 필터 — 라이브 확定 P1 갭 봉쇄 실증."""
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


async def _seed_human(session, org_id, project_id=None, *, grant_project: bool = False):
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    if grant_project and project_id is not None:
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, permission="granted",
        ))
        await session.commit()
    return user_id, om.id


async def _seed_stories_scenario(session):
    """org + project A(caller 접근권 없음) + project B(caller 접근권 있음) + story."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.pm import Story

    org = Organization(id=uuid.uuid4(), name="SEC-S3 Org", slug=f"sec-s3-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_no_access = Project(id=uuid.uuid4(), org_id=org.id, name="No Access Project")
    project_with_access = Project(id=uuid.uuid4(), org_id=org.id, name="With Access Project")
    session.add_all([project_no_access, project_with_access])
    await session.commit()

    story_no_access = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project_no_access.id,
        title="Story in inaccessible project", status="backlog",
    )
    story_with_access = Story(
        id=uuid.uuid4(), org_id=org.id, project_id=project_with_access.id,
        title="Story in accessible project", status="backlog",
    )
    session.add_all([story_no_access, story_with_access])
    await session.commit()

    caller_user_id, caller_om_id = await _seed_human(session, org.id, project_with_access.id, grant_project=True)

    return {
        "org_id": org.id, "caller_user_id": caller_user_id,
        "project_no_access_id": project_no_access.id, "project_with_access_id": project_with_access.id,
        "story_no_access_id": story_no_access.id, "story_with_access_id": story_with_access.id,
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
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_delete_story_without_project_access_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_stories_scenario(s)

        await _setup_app(app, Session, seeded["caller_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{seeded['story_no_access_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Story
            story = (await s.execute(
                select(Story).where(Story.id == seeded["story_no_access_id"])
            )).scalar_one_or_none()
            assert story is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_story_with_project_access_succeeds():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_stories_scenario(s)

        await _setup_app(app, Session, seeded["caller_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{seeded['story_with_access_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_conversation_cross_org_participant_filtered():
    """까심 재현: cross-org participant_id가 org 필터 없이 그대로 insert되던 갭 — 봉쇄 확認."""
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
            org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
            s.add_all([org_a, org_b])
            await s.commit()
            project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
            s.add(project_a)
            await s.commit()

            caller_user_id, _ = await _seed_human(s, org_a.id, project_a.id, grant_project=True)
            same_org_user_id, same_org_om_id = await _seed_human(s, org_a.id)
            other_org_user_id, other_org_om_id = await _seed_human(s, org_b.id)

        await _setup_app(app, Session, caller_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/conversations",
                json={
                    "type": "group", "project_id": str(project_a.id),
                    "participant_ids": [str(same_org_om_id), str(other_org_om_id)],
                },
            )
            assert resp.status_code == 201, resp.text
            conv_id = resp.json()["id"]
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.conversation import ConversationParticipant
            participant_ids = {
                r[0] for r in (await s.execute(
                    select(ConversationParticipant.member_id).where(
                        ConversationParticipant.conversation_id == uuid.UUID(conv_id)
                    )
                )).all()
            }
            assert same_org_om_id in participant_ids
            assert other_org_om_id not in participant_ids
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
