"""story 5041 ② (server, step 2) — an agent's call to an approvable road gets what the USER's setting says (PO 11-27, seq 20579):

  ask   → the ask is kept, a person presses it (as before)
  block → 403 AGENT_ACTION_BLOCKED, nothing kept, no card
  auto  → the call goes on as the AGENT, under its own rights — and only for the one agent in the one project the setting names; another project / another agent is still a card

Real database, the real routes; the settings are written through the real settings API (an organisation admin's person session).
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _exists,
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

URL = "/api/v2/agent-action-policy"


async def _set(app, Session, d, **body):
    await _act_as(app, Session, d["admin_user"], d["org_id"])
    async with _client_for(app) as c:
        r = await c.put(URL, json=body)
    assert r.status_code == 200, r.text


async def _as_agent_delete(app, Session, d, agent_id, path):
    await _act_as(app, Session, agent_id, d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.delete(path)


async def _second_project_with_story(Session, d, *, agent_ids):
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    async with Session() as s:
        p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Second Project")
        s.add(p2)
        await s.commit()
        for a in agent_ids:
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, member_id=a, permission="granted", role="member"))
        story = Story(id=uuid.uuid4(), org_id=d["org_id"], project_id=p2.id, title="Story in the second project", status="backlog")
        s.add(story)
        await s.commit()
        return p2.id, story.id


@pytest.mark.anyio
async def test_auto_runs_the_call_as_the_agent_only_for_that_agent_in_that_project():
    from sqlalchemy import select, text

    from app.main import app
    from app.models.deletion_audit import DeletionAuditLog
    from app.models.member import Member
    from app.models.pm import Story
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Other Agent", is_active=True, owner_member_id=d["admin_om"])
            s.add(other)
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=d["project_id"], member_id=other.id, permission="granted", role="member"))
            await s.commit()
        p2, story2 = await _second_project_with_story(Session, d, agent_ids=[d["agent_id"]])

        # nothing set: a card, as before
        r = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{d['story_id']}")
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert await _exists(Session, Story, d["story_id"])

        # «always allow» for THIS agent in THIS project
        await _set(app, Session, d, action_key="story.delete", level="auto", project_id=str(d["project_id"]), agent_id=str(d["agent_id"]))
        # … another agent in the same project: still a card
        r_other = await _as_agent_delete(app, Session, d, other.id, f"/api/v2/stories/{d['story_id']}")
        assert r_other.status_code == 202, r_other.text
        # … the same agent in ANOTHER project: still a card
        r_p2 = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{story2}")
        assert r_p2.status_code == 202, r_p2.text
        assert await _exists(Session, Story, story2) and await _exists(Session, Story, d["story_id"])

        # … the agent, the project, the action: no card — it is done, as the agent
        before = len(await _requests(Session, d["org_id"]))
        done = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{d['story_id']}")
        assert done.status_code == 200 and done.json() == {"ok": True}, done.text
        assert not await _exists(Session, Story, d["story_id"]), "it ran"
        assert len(await _requests(Session, d["org_id"])) == before, "and no request was kept"
        async with Session() as s:
            audit = (await s.execute(select(DeletionAuditLog).where(DeletionAuditLog.entity_id == d["story_id"]))).scalars().one()
            logged = (await s.execute(text("SELECT actor_type, actor_id, context FROM activity_logs WHERE org_id = :o AND action = 'agent_action.auto_allowed'"), {"o": d["org_id"]})).all()
        assert audit.actor_id == d["agent_id"], "the deletion audit names the AGENT, not a person"
        assert len(logged) == 1 and logged[0][0] == "agent" and logged[0][1] == d["agent_id"] and logged[0][2] == {"action_key": "story.delete", "setting": "project_agent"}

        # taking the setting away puts the card back
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            assert (await c.delete(URL, params={"action_key": "story.delete", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})).json() == {"removed": True}
        again = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{story2}")
        assert again.status_code == 202
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_block_refuses_with_a_code_and_keeps_nothing():
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _set(app, Session, d, action_key="story.delete", level="block", project_id=str(d["project_id"]))
        r = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{d['story_id']}")
        assert r.status_code == 403 and r.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", r.text
        assert await _exists(Session, Story, d["story_id"])
        assert await _requests(Session, d["org_id"]) == [], "nothing is kept for a blocked call"
        # a PERSON is not an agent: the setting does not touch their own delete
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            assert (await c.delete(f"/api/v2/stories/{d['story_id']}")).status_code == 200
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_road_still_decides_what_an_agent_may_do_and_admin_only_actions_have_no_auto_slot():
    from sqlalchemy import text

    from app.main import app
    from app.models.pm import Goal

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        # no auto slot for the two actions whose road demands an organisation admin (an agent never is one)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in ("goal.delete", "reward.give"):
                r = await c.put(URL, json={"action_key": key, "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
                assert r.status_code == 422 and r.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, r.text)
        # a hand-written `auto` row for goal.delete is not honoured: the agent is still given the card
        async with Session() as s:
            await s.execute(text("INSERT INTO hitl_gate_config (org_id, project_id, agent_id, work_type, actor_type, level) VALUES (:o, :p, :a, 'action:goal.delete', 'agent', 'auto')"),
                            {"o": d["org_id"], "p": d["project_id"], "a": d["agent_id"]})
            await s.commit()
        r = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/goals/{d['goal_id']}")
        assert r.status_code == 202, r.text
        assert await _exists(Session, Goal, d["goal_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("key, path_of, model_name", [
    ("task.delete", lambda d: f"/api/v2/tasks/{d['task_id']}", "Task"),
    ("doc.delete", lambda d: f"/api/v2/docs/{d['doc_id']}", "Doc"),
    ("sprint.delete", lambda d: f"/api/v2/sprints/{d['sprint_id']}", "Sprint"),
])
async def test_the_other_roads_follow_the_same_setting(key, path_of, model_name):
    from app.main import app
    from app.models.doc import Doc
    from app.models.pm import Sprint, Task

    model = {"Task": Task, "Doc": Doc, "Sprint": Sprint}[model_name]
    row_id_key = {"task.delete": "task_id", "doc.delete": "doc_id", "sprint.delete": "sprint_id"}[key]
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        asked = await _as_agent_delete(app, Session, d, d["agent_id"], path_of(d))
        assert asked.status_code == 202, (key, asked.text)
        assert await _exists(Session, model, d[row_id_key])
        await _set(app, Session, d, action_key=key, level="auto", project_id=str(d["project_id"]), agent_id=str(d["agent_id"]))
        done = await _as_agent_delete(app, Session, d, d["agent_id"], path_of(d))
        assert done.status_code in (200, 204), (key, done.status_code, done.text)
        assert not await _exists(Session, model, d[row_id_key]), f"{key}: it ran as the agent"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_a_setting_for_a_project_the_agent_cannot_see_does_not_reach_that_project():
    """codex on this PR: the setting names a project and an agent — it must never be the way into a project the AGENT itself cannot see (the project check comes before the level is read, for the agent's own identity)"""
    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        p2, story2 = await _second_project_with_story(Session, d, agent_ids=[])  # the agent holds NO access to the second project
        await _set(app, Session, d, action_key="story.delete", level="auto", project_id=str(p2), agent_id=str(d["agent_id"]))
        r = await _as_agent_delete(app, Session, d, d["agent_id"], f"/api/v2/stories/{story2}")
        assert r.status_code == 404, r.text
        assert await _exists(Session, Story, story2), "the setting did not open the project"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
