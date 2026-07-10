"""E-CANVAS C0-S1(story cfa61434): comment.created 이벤트 전파 배선 — 실 Postgres 검증.

crux 확定대로 신규 인프라 0 — `add_comment`→기존 `dispatch_notification` 배선만. 실 alembic
마이그 필요(team_members 뷰 에이전트 인식 경로)."""
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
    """org + project + 3 agents(author·assignee·mentioned) + story(assignee 배정)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story
    from app.models.story_assignee import StoryAssignee

    org = Organization(id=uuid.uuid4(), name="C0-S1 Org", slug=f"c0s1-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="C0-S1 Project")
    author = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Comment Author", is_active=True)
    assignee = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Story Assignee", is_active=True)
    mentioned = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Mentioned Agent", is_active=True)
    session.add_all([project, author, assignee, mentioned])
    await session.commit()

    grants = [
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member")
        for m in (author, assignee, mentioned)
    ]
    session.add_all(grants)

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="C0-S1 Story", status="in-progress")
    session.add(story)
    await session.commit()

    session.add(StoryAssignee(id=uuid.uuid4(), org_id=org.id, story_id=story.id, member_id=assignee.id))
    await session.commit()

    return org.id, project.id, author.id, assignee.id, mentioned.id, story.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        # 실 app.core.database.get_db와 동형(post-yield commit) — dispatch_notification은
        # flush()만 하고 최종 commit은 get_db 래퍼에 위임하는 컨벤션이라, 단순 yield-only
        # override는 그 커밋을 누락해 flush된 Event가 세션 종료 시 조용히 버려진다(실측 확認).
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_comment_creates_event_for_assignee_and_mentioned_not_author():
    from app.main import app
    from sqlalchemy import select
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, author_id, assignee_id, mentioned_id, story_id = await _seed(s)

        await _setup_app(app, Session, author_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{story_id}/comments",
                json={"content": "리뷰 부탁하는", "mentioned_ids": [str(mentioned_id)]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == org_id, Event.event_type == "dispatched",
                )
            )).scalars().all()
            recipient_ids = {r.recipient_id for r in rows}
            # assignee + mentioned 둘 다 받음, author(본인)는 제외
            assert recipient_ids == {assignee_id, mentioned_id}
            for r in rows:
                assert r.status == "pending"
                assert r.source_entity_type == "story"
                assert r.source_entity_id == story_id
                # Event.event_type 컬럼 자체는 "dispatched"(dispatch_notification 컨벤션) —
                # 실 도메인 타입은 payload에 실려간다(established pattern, agent_dispatch.py 동형).
                assert r.payload["event_type"] == "comment.created"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_author_is_assignee_gets_no_self_notification():
    """작성자 본인이 assignee여도 자기 자신에게 알림 안 감(회귀 방지)."""
    from app.main import app
    from sqlalchemy import select
    from app.models.event import Event
    from app.models.story_assignee import StoryAssignee

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, author_id, assignee_id, mentioned_id, story_id = await _seed(s)
            # author를 추가 assignee로도 등록
            s.add(StoryAssignee(id=uuid.uuid4(), org_id=org_id, story_id=story_id, member_id=author_id))
            await s.commit()

        await _setup_app(app, Session, author_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{story_id}/comments",
                json={"content": "셀프 코멘트", "mentioned_ids": []},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == org_id, Event.event_type == "dispatched")
            )).scalars().all()
            recipient_ids = {r.recipient_id for r in rows}
            assert author_id not in recipient_ids
            assert recipient_ids == {assignee_id}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_mentioned_id_filtered_out():
    """다른 org 소속 member_id를 mentioned_ids로 보내도 필터링(cross-org 누출 방지)."""
    from app.main import app
    from app.models.member import Member
    from app.models.organization import Organization
    from sqlalchemy import select
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, author_id, assignee_id, mentioned_id, story_id = await _seed(s)
            other_org = Organization(id=uuid.uuid4(), name="Other Org", slug=f"other-{uuid.uuid4().hex[:8]}")
            s.add(other_org)
            await s.commit()
            stranger = Member(id=uuid.uuid4(), org_id=other_org.id, type="agent", name="Stranger", is_active=True)
            s.add(stranger)
            await s.commit()
            stranger_id = stranger.id

        await _setup_app(app, Session, author_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{story_id}/comments",
                json={"content": "cross-org mention test", "mentioned_ids": [str(stranger_id)]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == org_id, Event.event_type == "dispatched")
            )).scalars().all()
            recipient_ids = {r.recipient_id for r in rows}
            assert stranger_id not in recipient_ids
            assert recipient_ids == {assignee_id}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_with_no_recipients_regression_zero():
    """assignee·mention 둘 다 없으면 dispatch 자체를 안 함(빈 target_member_ids 스킵) — 회귀0."""
    from app.main import app
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story
    from sqlalchemy import select
    from app.models.event import Event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="C0-S1 NoRecip Org", slug=f"c0s1n-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            author = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Author", is_active=True)
            s.add_all([project, author])
            await s.commit()
            grant = ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, member_id=author.id, permission="granted", role="member",
            )
            s.add(grant)
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Unassigned Story", status="backlog")
            s.add(story)
            await s.commit()
            org_id, author_id, story_id = org.id, author.id, story.id

        await _setup_app(app, Session, author_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{story_id}/comments",
                json={"content": "아무도 안 받는 코멘트", "mentioned_ids": []},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == org_id, Event.event_type == "dispatched")
            )).scalars().all()
            assert rows == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
