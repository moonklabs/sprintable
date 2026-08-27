"""story #3126(#2341 AC1 후속, ㉡′ — PO 승인 2026-08-27) —
`GET /api/v2/goals?include=glance`의 `latest_story_activity_at` 실PG 검증.

계약 핵심:
  ①이 goal 소속 non-done story의 updated_at 최댓값(있으면)
  ②story가 전부 done이거나 0건이면 None(모름을 임의값으로 위조하지 않는다)
  ③done story의 updated_at은 최댓값 계산에서 제외된다(설령 그게 더 최근이어도)
  ④`include=glance` 없으면 노출되지 않는다(#2298의 byte-identical 계약과 동일 축)
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

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


async def _make_story(session, org_id, project_id, epic_id, status="backlog", title="Story", updated_at=None):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, epic_id=epic_id,
        title=title, status=status,
    )
    session.add(story)
    await session.commit()
    if updated_at is not None:
        # updated_at은 onupdate=MONOTONIC_UPDATED_AT_ONUPDATE라 insert 값을 그대로 두지 않는다
        # (server_default=func.now()) — 표본을 정확한 시각으로 통제하려면 별도 UPDATE로 덮는다.
        from sqlalchemy import update
        from app.models.pm import Story as StoryModel
        await session.execute(update(StoryModel).where(StoryModel.id == story.id).values(updated_at=updated_at))
        await session.commit()
        await session.refresh(story)
    return story


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user

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
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def test_no_stories_yields_none_not_a_fabricated_timestamp():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()[0]["latest_story_activity_at"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_only_done_stories_yields_none_done_excluded_from_max():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            # done story의 updated_at이 아무리 최근이어도(오늘 방금 done 처리됐어도) 최댓값
            # 계산에서 빠져야 한다 — "닫힌 것"은 "지금 움직이는 중"이 아니다.
            await _make_story(
                s, org.id, project.id, goal.id, status="done", title="Done",
                updated_at=datetime.now(timezone.utc),
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()[0]["latest_story_activity_at"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_picks_max_updated_at_among_non_done_stories_only():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        older = now - timedelta(days=10)
        newest_non_done = now - timedelta(hours=1)
        newest_overall_but_done = now  # 가장 최근이지만 done — 뽑히면 안 됨(양성대조 겸함).

        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            await _make_story(s, org.id, project.id, goal.id, status="backlog", title="Old", updated_at=older)
            await _make_story(
                s, org.id, project.id, goal.id, status="in-progress", title="Newest-non-done",
                updated_at=newest_non_done,
            )
            await _make_story(
                s, org.id, project.id, goal.id, status="done", title="Newest-but-done",
                updated_at=newest_overall_but_done,
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/goals", params={"project_id": str(project.id), "include": "glance"},
            )
            assert resp.status_code == 200, resp.text
            got = resp.json()[0]["latest_story_activity_at"]
            assert got is not None
            got_dt = datetime.fromisoformat(got.replace("Z", "+00:00"))
            # 초 단위 비교(직렬화 round-trip 오차 감안) — done story의 시각(newest_overall_but_done)이
            # 아니라 non-done 중 최댓값(newest_non_done)과 일치해야 한다.
            assert abs((got_dt - newest_non_done).total_seconds()) < 2
            assert abs((got_dt - newest_overall_but_done).total_seconds()) > 1800
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_without_include_glance_the_field_is_absent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            await _make_story(s, org.id, project.id, goal.id, status="in-progress", title="S")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/goals", params={"project_id": str(project.id)})
            assert resp.status_code == 200, resp.text
            assert "latest_story_activity_at" not in resp.json()[0]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
