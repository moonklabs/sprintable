"""story #4497 — a story made with an assignee announces it, like PATCH /{id} does.

Mirko's run · PO 09:54Z: POST /stories with an assignee (MCP add_story(assignee_id) · an agent's API call) sent nothing — the
assignee agent's ledger stayed empty, while assigning the same story again by PATCH reached it at once. The web board makes a
story without one and assigns by PATCH, so it never showed there. create_story now calls the same function as PATCH (old None)
after every write of the request is committed (PO conditions: the reference reconcile's «fails → the whole creation rolls back»
stays whole · the 201 body is built as before · best-effort).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,  # the seeds write team_members (a table in the destructive schema, a view when migrated)
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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


async def _seed():
    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        # a person assignable on the board: a project team member backed by a user (what the assignee picker lists)
        from app.models.team import TeamMember

        other_user = await _seed_human(s, org_id, role="member")
        other_human = uuid.uuid4()
        s.add(TeamMember(id=other_human, org_id=org_id, project_id=project_id, type="human", name="다른 사람", user_id=other_user, is_active=True))
        await s.commit()
        agent_id = await _seed_agent(s, org_id, project_id, grant=True)
    return engine, Session, org_id, project_id, owner_id, other_human, agent_id


async def _create(Session, org_id, project_id, owner_id, **extra):
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            return await client.post("/api/v2/stories", json={
                "org_id": str(org_id), "project_id": str(project_id), "title": "담당 넣어 만든 스토리", **extra,
            })
    finally:
        app.dependency_overrides.clear()


async def _assigned_events(Session, story_id):
    from sqlalchemy import select

    from app.models.event import Event

    async with Session() as s:
        return (await s.execute(select(Event).where(
            Event.event_type == "story_assigned", Event.source_entity_id == story_id,
        ))).scalars().all()


async def _assigned_notifications(Session, story_id):
    from sqlalchemy import select

    from app.models.notification import Notification

    async with Session() as s:
        return (await s.execute(select(Notification).where(
            Notification.type == "story_assigned", Notification.reference_id == story_id,
        ))).scalars().all()


async def test_a_story_made_with_an_agent_assignee_reaches_the_agent_and_answers_201_as_before():
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(agent_id))
        assert r.status_code == 201, r.text
        body = r.json()
        data = body.get("data", body)
        assert data["assignee_id"] == str(agent_id) and data["assignee_ids"] == [str(agent_id)]
        assert data["title"] and data["id"] and "trust_stage" in data and "project_slug" in data  # the body after the commit
        story_id = uuid.UUID(data["id"])
        [ev] = await _assigned_events(Session, story_id)
        assert (ev.recipient_id, ev.recipient_type) == (agent_id, "agent") and ev.recipient_seq is not None
    finally:
        await engine.dispose()


async def test_a_story_made_with_a_human_assignee_notifies_them_once():
    engine, Session, org_id, project_id, owner_id, other_human, _agent = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(other_human))
        assert r.status_code == 201, r.text
        story_id = uuid.UUID(r.json().get("data", r.json())["id"])
        assert len(await _assigned_notifications(Session, story_id)) == 1
        assert await _assigned_events(Session, story_id) == []  # a human gets the notification, not a gateway Event
    finally:
        await engine.dispose()


async def test_a_story_made_without_an_assignee_announces_nothing():
    engine, Session, org_id, project_id, owner_id, _other, _agent = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id)
        assert r.status_code == 201, r.text
        story_id = uuid.UUID(r.json().get("data", r.json())["id"])
        assert await _assigned_events(Session, story_id) == [] and await _assigned_notifications(Session, story_id) == []
    finally:
        await engine.dispose()


async def test_a_creation_rolled_back_by_its_reconcile_leaves_no_story_and_no_event(monkeypatch):
    """PO condition ①: the announcement comes after every write is committed — a reconcile that fails still rolls the whole
    creation back, and nothing was announced for a story that does not exist."""
    from sqlalchemy import select

    import app.routers.stories as stories_router
    from app.models.event import Event
    from app.models.pm import Story

    async def boom(*args, **kwargs):
        raise RuntimeError("the reference reconcile failed")

    monkeypatch.setattr(stories_router, "_reconcile_story_references_and_candidates", boom)
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        try:
            r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(agent_id))
            assert r.status_code >= 500
        except RuntimeError:
            pass  # the test client may raise the app's exception instead of answering 500
        async with Session() as s:
            assert (await s.execute(select(Story).where(Story.project_id == project_id))).scalars().all() == []
            assert (await s.execute(select(Event).where(
                Event.event_type == "story_assigned", Event.recipient_id == agent_id,
            ))).scalars().all() == []
    finally:
        await engine.dispose()
