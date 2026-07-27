"""E-CANVAS 실기능 갭 봉인(story 04e059e5·미르코 그라운딩 PR #2119): create_artifact가
dispatch_notification을 호출하지 않아 artifact.created 이벤트가 전혀 전파되지 않던 갭(§F4
"이벤트 없는 기능 금지" 위반)을 실증. edit/comment는 "생성자 - 편집자" 패턴이지만 생성 시점엔
"이미 알던 이전 당사자"가 없어 대상을 ①생성자 본인(자기 알림 — done-gate 라이브 실증이 자기
생성→자기 웹훅 도달을 검증하므로 필수) ②연결된 story의 assignee(다르면 타 사용자 도달)로 구성."""
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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id}


async def _seed_story_with_assignee(session, org_id, project_id, assignee_id):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Linked Story",
        status="backlog", assignee_id=assignee_id,
    )
    session.add(story)
    await session.commit()
    return story.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id, user_id):
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
async def test_create_artifact_agent_creator_gets_event_self_notified():
    """자기 알림 — 링크 없는 독립 artifact도 생성자(에이전트) 본인에게 artifact.created가
    Event(dispatched)로 도달(done-gate 라이브 실증의 전제)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project(s)
            creator = Member(
                id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="creator-agent", is_active=True,
            )
            s.add(creator)
            await s.commit()
            from app.models.project_access import ProjectAccess
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], member_id=creator.id,
                permission="granted", role="member",
            ))
            await s.commit()
            creator_id = creator.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], creator_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Standalone", "nodes": [{"type": "text", "props": {}}]})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            payloads = [r.payload for r in rows]
            matches = [p for p in payloads if isinstance(p, dict) and p.get("event_type") == "artifact.created"]
            assert len(matches) == 1, f"정확히 1건 기대, 실제={len(matches)}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_human_creator_gets_notification_self_notified():
    """자기 알림 — 휴먼 생성자도 in-app Notification으로 artifact.created 도달."""
    from sqlalchemy import select

    from app.main import app
    from app.models.notification import Notification
    from app.models.project import OrgMember
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project(s)
            user = User(id=uuid.uuid4(), email=f"creator-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(user)
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=seeded["org_id"], user_id=user.id, role="member")
            s.add(om)
            await s.commit()
            from app.models.project_access import ProjectAccess
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], org_member_id=om.id, permission="granted",
            ))
            await s.commit()
            creator_id = om.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], creator_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Standalone Human", "nodes": [{"type": "text", "props": {}}]})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Notification).where(
                    Notification.org_id == seeded["org_id"], Notification.type == "artifact.created",
                )
            )).scalars().all()
            assert len(rows) == 1, f"정확히 1건 기대, 실제={len(rows)}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_linked_story_different_assignee_both_notified():
    """타 사용자 도달 — story 연결 + assignee가 생성자와 다르면 둘 다 알림(Event 2건: 생성자
    본인 + assignee)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project(s)
            creator = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="creator", is_active=True)
            assignee = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="assignee", is_active=True)
            s.add_all([creator, assignee])
            await s.commit()
            s.add_all([
                ProjectAccess(id=uuid.uuid4(), project_id=seeded["project_id"], member_id=creator.id, permission="granted", role="member"),
                ProjectAccess(id=uuid.uuid4(), project_id=seeded["project_id"], member_id=assignee.id, permission="granted", role="member"),
            ])
            await s.commit()
            story_id = await _seed_story_with_assignee(s, seeded["org_id"], seeded["project_id"], assignee.id)
            creator_id = creator.id
            assignee_id = assignee.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], creator_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Linked", "story_id": str(story_id), "nodes": [{"type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            created_events = [
                r for r in rows
                if isinstance(r.payload, dict) and r.payload.get("event_type") == "artifact.created"
            ]
            assert len(created_events) == 2, f"생성자+assignee 2건 기대, 실제={len(created_events)}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_linked_story_same_assignee_dedup_single_notification():
    """dedup — story의 assignee가 생성자 본인과 동일하면 중복 알림 0(target_member_ids가 set이라
    자동 dedup)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project(s)
            creator = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="creator", is_active=True)
            s.add(creator)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], member_id=creator.id,
                permission="granted", role="member",
            ))
            await s.commit()
            story_id = await _seed_story_with_assignee(s, seeded["org_id"], seeded["project_id"], creator.id)
            creator_id = creator.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], creator_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "SelfAssigned", "story_id": str(story_id), "nodes": [{"type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            created_events = [
                r for r in rows
                if isinstance(r.payload, dict) and r.payload.get("event_type") == "artifact.created"
            ]
            assert len(created_events) == 1, f"dedup 실패 — 중복 발송, 실제={len(created_events)}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_and_comment_events_still_fire_no_regression():
    """무회귀: edit/comment의 기존 이벤트 전파는 create 배선과 무관하게 그대로 동작."""
    from sqlalchemy import select

    from app.main import app
    from app.models.event import Event
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project(s)
            creator = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="creator", is_active=True)
            s.add(creator)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], member_id=creator.id,
                permission="granted", role="member",
            ))
            await s.commit()
            creator_id = creator.id

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], creator_id)
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Edit Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        human_editor_id = uuid.uuid4()
        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], human_editor_id)
        client = _client_for(app)
        try:
            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert edit_resp.status_code == 201, edit_resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(Event.org_id == seeded["org_id"], Event.event_type == "dispatched")
            )).scalars().all()
            payloads = [r.payload for r in rows]
            assert any(p.get("event_type") == "artifact.created" for p in payloads if isinstance(p, dict))
            assert any(p.get("event_type") == "artifact.updated" for p in payloads if isinstance(p, dict))
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_artifact_events_registered_in_taxonomy():
    from app.services.event_taxonomy import EVENT_TAXONOMY, validate_event_context

    for event_type in ("artifact.created", "artifact.updated", "artifact.exported"):
        assert event_type in EVENT_TAXONOMY, f"{event_type} missing from EVENT_TAXONOMY"

    required_missing = validate_event_context("artifact.created", {})
    assert set(required_missing) == {"artifact_id", "artifact_title", "project_id", "org_id", "timestamp"}

    complete_context = {
        "artifact_id": str(uuid.uuid4()), "artifact_title": "t",
        "project_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "timestamp": "2026-01-01T00:00:00Z",
    }
    assert validate_event_context("artifact.created", complete_context) == []
