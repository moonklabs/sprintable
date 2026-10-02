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


async def test_an_announcement_that_fails_on_a_db_write_still_answers_201_once(monkeypatch):
    """PO 10:20Z — the announcement's own DB write fails (here at the agent Event's seq, after its flush): the story is already
    committed, so the request answers 201 with it (one row, no announcement left half-written) — not a 500 that a retrying agent
    or MCP client would turn into a second story."""
    from sqlalchemy import select, text

    import app.services.event_seq as event_seq
    from app.models.pm import Story

    async def broken_seq(db, ev):
        await db.execute(text("SELECT 1/0"))  # a real DB error: the session now needs a rollback

    monkeypatch.setattr(event_seq, "assign_recipient_seq", broken_seq)
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(agent_id))
        assert r.status_code == 201, r.text
        data = r.json().get("data", r.json())
        assert data["assignee_id"] == str(agent_id) and data["assignee_ids"] == [str(agent_id)]
        async with Session() as s:
            assert len((await s.execute(select(Story).where(Story.project_id == project_id))).scalars().all()) == 1
        assert await _assigned_events(Session, uuid.UUID(data["id"])) == []
    finally:
        await engine.dispose()


async def _patch(Session, org_id, owner_id, path, payload):
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            return await client.patch(path, json=payload)
    finally:
        app.dependency_overrides.clear()


def _seq_fails(monkeypatch, *, times: int):
    """The agent Event's seq step runs a failing SQL statement `times` times (a real DB error), then works again."""
    from sqlalchemy import text

    import app.services.event_seq as event_seq

    real = event_seq.assign_recipient_seq
    left = {"n": times}

    async def maybe_broken(db, ev):
        if left["n"] > 0:
            left["n"] -= 1
            await db.execute(text("SELECT 1/0"))
        return await real(db, ev)

    monkeypatch.setattr(event_seq, "assign_recipient_seq", maybe_broken)


async def test_a_patch_whose_announcement_fails_still_answers_200_with_the_change(monkeypatch):
    """PO 10:21Z — the same class on PATCH /{id}: the announcement's DB write fails → the committed assignee answers 200 (not a
    500 disguising a saved change), no half-written story_assigned left."""
    from sqlalchemy import select

    from app.models.pm import Story

    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id)
        story_id = r.json().get("data", r.json())["id"]
        _seq_fails(monkeypatch, times=1)
        r = await _patch(Session, org_id, owner_id, f"/api/v2/stories/{story_id}", {"assignee_id": str(agent_id)})
        assert r.status_code == 200, r.text
        async with Session() as s:
            assert (await s.execute(select(Story.assignee_id).where(Story.id == uuid.UUID(story_id)))).scalar_one() == agent_id
        assert await _assigned_events(Session, uuid.UUID(story_id)) == []
    finally:
        await engine.dispose()


async def test_a_bulk_items_failed_announcement_does_not_stop_the_next_ones(monkeypatch):
    """PO 10:21Z — PATCH /bulk: one item's announcement fails on a DB write → the next item is still announced (before, the
    session stayed «needs rollback» and every later announcement failed too)."""
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        ids = []
        for _ in range(2):
            r = await _create(Session, org_id, project_id, owner_id)
            ids.append(r.json().get("data", r.json())["id"])
        _seq_fails(monkeypatch, times=1)  # the first item's announcement only
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {
            "items": [{"id": i, "assignee_id": str(agent_id)} for i in ids],
        })
        assert r.status_code == 200, r.text
        announced = [len(await _assigned_events(Session, uuid.UUID(i))) for i in ids]
        assert sorted(announced) == [0, 1]  # one failed, the other still reached the agent
    finally:
        await engine.dispose()


@pytest.mark.parametrize("failing", [1, 2])
async def test_a_bulk_items_failure_drops_only_its_own_half_not_the_others_writes(monkeypatch, failing):
    """PO 10:35Z — the rollback on one item's failure must not take what the request wrote and had not committed yet: the status
    loop's activity records and the earlier items' announcements (a person's notification). Three items move status and get a
    person as assignee; one announcement fails on a DB write → the others keep their story_assigned notification, every item
    keeps its status_changed activity. The first item failing pins the commit before the loop (nothing committed the status
    loop's writes yet); the second failing pins the commit after each announcement (the first item's notification)."""
    from sqlalchemy import select, text

    import app.services.notification_dispatch as notification_dispatch
    from app.models.pm import StoryActivity

    real = notification_dispatch.dispatch_notification
    calls = {"n": 0}

    async def second_fails(db, **kwargs):
        if kwargs.get("event_type") == "story_assigned":
            calls["n"] += 1
            if calls["n"] == failing:
                await db.execute(text("SELECT 1/0"))
        return await real(db, **kwargs)

    monkeypatch.setattr(notification_dispatch, "dispatch_notification", second_fails)
    engine, Session, org_id, project_id, owner_id, other_human, _agent = await _seed()
    try:
        ids = []
        for _ in range(3):
            r = await _create(Session, org_id, project_id, owner_id)
            ids.append(r.json().get("data", r.json())["id"])
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {
            "items": [{"id": i, "status": "ready-for-dev", "assignee_id": str(other_human)} for i in ids],
        })
        assert r.status_code == 200, r.text
        notified = [len(await _assigned_notifications(Session, uuid.UUID(i))) for i in ids]
        assert notified == [0 if n == failing else 1 for n in (1, 2, 3)], notified
        async with Session() as s:
            status_rows = (await s.execute(select(StoryActivity.story_id).where(
                StoryActivity.activity_type == "status_changed", StoryActivity.story_id.in_([uuid.UUID(i) for i in ids]),
            ))).scalars().all()
        assert sorted(map(str, status_rows)) == sorted(ids)
    finally:
        await engine.dispose()


# story #4497 (Qadir codex 01a0fc4a · PO 11:22Z) — an assignee from another org: refused before anything is saved or announced,
# on all three paths (it used to be saved, and the announcement put the story's title and description into that agent's inbox)

async def _foreign_agent(Session):
    async with Session() as s:
        org2, project2 = await _seed_org(s)
        return await _seed_agent(s, org2, project2, grant=True)


async def _events_to(Session, member_id):
    from sqlalchemy import select

    from app.models.event import Event

    async with Session() as s:
        return (await s.execute(select(Event).where(Event.recipient_id == member_id))).scalars().all()


async def _stories_in(Session, project_id):
    from sqlalchemy import select

    from app.models.pm import Story

    async with Session() as s:
        return (await s.execute(select(Story).where(Story.project_id == project_id))).scalars().all()


def _refused(r):
    assert r.status_code == 422, r.text
    assert "ASSIGNEE_NOT_IN_ORG" in r.text


async def test_creating_with_another_orgs_agent_as_assignee_is_refused_and_nothing_is_saved_or_sent():
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        foreign = await _foreign_agent(Session)
        _refused(await _create(Session, org_id, project_id, owner_id, assignee_id=str(foreign)))
        # one of several is enough to refuse — the org's own agent alongside does not let it through
        _refused(await _create(Session, org_id, project_id, owner_id, assignee_ids=[str(agent_id), str(foreign)]))
        assert await _stories_in(Session, project_id) == []
        assert await _events_to(Session, foreign) == []
        # contrast: the org's own agent alone still goes through
        assert (await _create(Session, org_id, project_id, owner_id, assignee_ids=[str(agent_id)])).status_code == 201
    finally:
        await engine.dispose()


async def test_patching_another_orgs_agent_in_is_refused_and_the_story_keeps_its_assignee():
    from sqlalchemy import select

    from app.models.pm import Story

    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        foreign = await _foreign_agent(Session)
        r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(agent_id))
        story_id = r.json().get("data", r.json())["id"]
        path = f"/api/v2/stories/{story_id}"
        _refused(await _patch(Session, org_id, owner_id, path, {"assignee_id": str(foreign)}))
        _refused(await _patch(Session, org_id, owner_id, path, {"assignee_ids": [str(agent_id), str(foreign)]}))
        async with Session() as s:
            assert (await s.execute(select(Story.assignee_id).where(Story.id == uuid.UUID(story_id)))).scalar_one() == agent_id
        assert await _events_to(Session, foreign) == []
    finally:
        await engine.dispose()


async def test_bulk_with_one_foreign_assignee_refuses_the_whole_request():
    from sqlalchemy import select

    from app.models.pm import Story

    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        foreign = await _foreign_agent(Session)
        ids = []
        for _ in range(2):
            r = await _create(Session, org_id, project_id, owner_id)
            ids.append(r.json().get("data", r.json())["id"])
        _refused(await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [
            {"id": ids[0], "assignee_id": str(agent_id), "status": "ready-for-dev"},
            {"id": ids[1], "assignee_id": str(foreign)},
        ]}))
        async with Session() as s:
            rows = (await s.execute(select(Story.assignee_id, Story.status).where(Story.id.in_([uuid.UUID(i) for i in ids])))).all()
        assert all(a is None for a, _ in rows) and all(st != "ready-for-dev" for _, st in rows)  # not even the valid item
        assert await _events_to(Session, foreign) == [] and await _events_to(Session, agent_id) == []
    finally:
        await engine.dispose()


async def _story_with_an_assignee_outside_todays_rule(Session, org_id, project_id, owner_id):
    """A story whose assignee was saved before this check and matches no member row today — what an old member id (the legacy
    table's · a removed member's) looks like to the rule. The columns have no FK (grant-only people), so such ids exist."""
    from sqlalchemy import text

    r = await _create(Session, org_id, project_id, owner_id)
    story_id = r.json().get("data", r.json())["id"]
    gone = uuid.uuid4()
    async with Session() as s:
        await s.execute(text("UPDATE stories SET assignee_id = :m WHERE id = :s"), {"m": gone, "s": uuid.UUID(story_id)})
        await s.execute(text("INSERT INTO story_assignees (id, org_id, story_id, member_id) VALUES (:i, :o, :s, :m)"),
                        {"i": uuid.uuid4(), "o": org_id, "s": uuid.UUID(story_id), "m": gone})
        await s.commit()
    return story_id, gone


async def test_an_edit_that_sends_back_an_assignee_already_on_the_story_is_not_refused():
    """PO 11:25Z — the web sends the assignee back unchanged with another field; one already on the story but outside today's
    rule must not refuse the edit (PATCH single · multiple · bulk). Adding a new outside id is still refused."""
    from sqlalchemy import select

    from app.models.pm import Story

    engine, Session, org_id, project_id, owner_id, _other, _agent = await _seed()
    try:
        story_id, gone = await _story_with_an_assignee_outside_todays_rule(Session, org_id, project_id, owner_id)
        path = f"/api/v2/stories/{story_id}"
        r = await _patch(Session, org_id, owner_id, path, {"title": "제목만 바꿈", "assignee_id": str(gone)})
        assert r.status_code == 200, r.text
        r = await _patch(Session, org_id, owner_id, path, {"title": "또 바꿈", "assignee_ids": [str(gone)]})
        assert r.status_code == 200, r.text
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [{"id": story_id, "assignee_id": str(gone), "priority": "high"}]})
        assert r.status_code == 200, r.text
        async with Session() as s:
            row = (await s.execute(select(Story.title, Story.assignee_id, Story.priority).where(Story.id == uuid.UUID(story_id)))).one()
        assert (row.title, row.assignee_id, row.priority) == ("또 바꿈", gone, "high")
        # contrast: the same id is refused where it is new
        other = (await _create(Session, org_id, project_id, owner_id)).json()
        other_id = other.get("data", other)["id"]
        _refused(await _patch(Session, org_id, owner_id, f"/api/v2/stories/{other_id}", {"assignee_id": str(gone)}))
        _refused(await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [{"id": other_id, "assignee_id": str(gone)}]}))
    finally:
        await engine.dispose()


async def test_an_old_id_that_is_only_a_second_assignee_is_also_already_on_the_story():
    """The same rule when the old id is only in the join rows (a second assignee — the single column holds the org's agent):
    PATCH sending both back and bulk naming it are not refused."""
    from sqlalchemy import text

    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id, assignee_id=str(agent_id))
        story_id = r.json().get("data", r.json())["id"]
        gone = uuid.uuid4()
        async with Session() as s:
            await s.execute(text("INSERT INTO story_assignees (id, org_id, story_id, member_id) VALUES (:i, :o, :s, :m)"),
                            {"i": uuid.uuid4(), "o": org_id, "s": uuid.UUID(story_id), "m": gone})
            await s.commit()
        r = await _patch(Session, org_id, owner_id, f"/api/v2/stories/{story_id}", {"title": "둘째 담당 그대로", "assignee_ids": [str(agent_id), str(gone)]})
        assert r.status_code == 200, r.text
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [{"id": story_id, "assignee_id": str(gone)}]})
        assert r.status_code == 200, r.text
    finally:
        await engine.dispose()
