"""story 5041 ② (server) — the user's «always allow · ask first · block» settings for what an agent may do (PO 11-27, seq 20579).

Proved on a real database through the real routes:
  · the resolution order, one test per layer — the narrow one wins (project+agent → project → organisation+agent → organisation → the action's default); put two layers in the other order and a line goes RED
  · the 19 «floor» rows cannot be set (409) and read `block` whatever is stored
  · `auto` only for ONE agent in ONE project; the organisation / project deletions have no auto slot; a stored `auto` that lacks a scope is not honoured
  · only an organisation owner / admin's PERSON session may set — an agent key, a personal key, a plain member are refused; a project / agent of another organisation is a 404
  · every change is one activity row; the old `done` / `merge` gate levels are untouched
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

URL = "/api/v2/agent-action-policy"
KEY = "story.delete"


async def _second_project_and_agent(Session, d):
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    async with Session() as s:
        p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Second Project")
        s.add(p2)
        await s.commit()
        a2 = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Second Agent", is_active=True, owner_member_id=d["admin_om"])
        s.add(a2)
        await s.commit()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, member_id=a2.id, permission="granted", role="member"))
        await s.commit()
        return p2.id, a2.id


async def _resolve(Session, d, *, project, agent, key=KEY):
    from app.services.agent_action_policy import resolve_action_level

    async with Session() as s:
        return await resolve_action_level(s, org_id=d["org_id"], project_id=project, agent_id=agent, action_key=key)


async def _put(c, **body):
    return await c.put(URL, json=body)


@pytest.mark.anyio
async def test_the_narrow_scope_wins_one_layer_at_a_time():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        p1, a1 = d["project_id"], d["agent_id"]
        p2, a2 = await _second_project_and_agent(Session, d)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            assert await _resolve(Session, d, project=p1, agent=a1) == ("ask", "default"), "nothing set: the action's own default"

            assert (await _put(c, action_key=KEY, level="block")).status_code == 200  # organisation
            assert await _resolve(Session, d, project=p1, agent=a1) == ("block", "org")

            assert (await _put(c, action_key=KEY, level="ask", agent_id=str(a1))).status_code == 200  # organisation + agent
            assert await _resolve(Session, d, project=p1, agent=a1) == ("ask", "org_agent"), "organisation+agent beats the organisation"
            assert await _resolve(Session, d, project=p1, agent=a2) == ("block", "org"), "another agent still reads the organisation's"

            assert (await _put(c, action_key=KEY, level="block", project_id=str(p1))).status_code == 200  # project
            assert await _resolve(Session, d, project=p1, agent=a1) == ("block", "project"), "project beats organisation+agent"
            assert await _resolve(Session, d, project=p2, agent=a1) == ("ask", "org_agent"), "another project is not touched"

            assert (await _put(c, action_key=KEY, level="auto", project_id=str(p1), agent_id=str(a1))).status_code == 200  # project + agent
            assert await _resolve(Session, d, project=p1, agent=a1) == ("auto", "project_agent"), "project+agent beats everything"
            assert await _resolve(Session, d, project=p1, agent=a2) == ("block", "project"), "another agent in the same project is not allowed by this"
            assert await _resolve(Session, d, project=p2, agent=a1) == ("ask", "org_agent"), "the same agent in another project is still asked"

            # clearing the narrowest goes back to the next one
            gone = await c.delete(URL, params={"action_key": KEY, "project_id": str(p1), "agent_id": str(a1)})
            assert gone.status_code == 200 and gone.json() == {"removed": True}
            assert await _resolve(Session, d, project=p1, agent=a1) == ("block", "project")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_floor_rows_cannot_be_set_and_read_block_whatever_is_stored():
    from sqlalchemy import text

    from app.main import app
    from app.services.agent_action_policy import FLOOR_ACTIONS

    assert len(FLOOR_ACTIONS) == 19, "the survey table's 19 «그대로 막음» rows"
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in FLOOR_ACTIONS:
                for level in ("auto", "ask"):
                    r = await _put(c, action_key=key, level=level, project_id=str(d["project_id"]), agent_id=str(d["agent_id"]))
                    assert r.status_code == 409 and r.json()["error"]["code"] == "ACTION_POLICY_FLOOR", (key, level, r.text)
            assert (await c.delete(URL, params={"action_key": "gate.approve"})).status_code == 409
        # even a row written by hand (a bug, a script) does not open it
        async with Session() as s:
            await s.execute(text("INSERT INTO hitl_gate_config (org_id, project_id, agent_id, work_type, actor_type, level) VALUES (:o, :p, :a, 'action:gate.approve', 'agent', 'auto')"),
                            {"o": d["org_id"], "p": d["project_id"], "a": d["agent_id"]})
            await s.commit()
        assert await _resolve(Session, d, project=d["project_id"], agent=d["agent_id"], key="gate.approve") == ("block", "floor")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_auto_is_for_one_agent_in_one_project_only():
    from sqlalchemy import text

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        p, a = str(d["project_id"]), str(d["agent_id"])
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for scope in ({}, {"project_id": p}, {"agent_id": a}):
                r = await _put(c, action_key=KEY, level="auto", **scope)
                assert r.status_code == 422 and r.json()["error"]["code"] == "ACTION_POLICY_AUTO_NEEDS_PROJECT_AND_AGENT", (scope, r.text)
            # the organisation / project deletions are always a card — no auto slot even for one agent in one project
            for key in ("org.delete", "project.delete"):
                r = await _put(c, action_key=key, level="auto", project_id=p, agent_id=a)
                assert r.status_code == 422 and r.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, r.text)
                assert (await _put(c, action_key=key, level="ask", project_id=p, agent_id=a)).status_code == 200
            assert (await _put(c, action_key="nonsense.action", level="ask")).status_code == 422
        # a stored `auto` that lacks a scope (written by hand) is not honoured
        async with Session() as s:
            await s.execute(text("INSERT INTO hitl_gate_config (org_id, work_type, actor_type, level) VALUES (:o, 'action:task.delete', 'agent', 'auto')"), {"o": d["org_id"]})
            await s.commit()
        assert await _resolve(Session, d, project=d["project_id"], agent=d["agent_id"], key="task.delete") == ("ask", "org"), "wider than the rules allow reads as ask"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_only_an_admin_persons_session_may_set_and_nothing_reaches_across_organisations():
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other_org = Organization(id=uuid.uuid4(), name="Other Org", slug=f"other-{uuid.uuid4().hex[:8]}")
            s.add(other_org)
            await s.commit()
            foreign = Project(id=uuid.uuid4(), org_id=other_org.id, name="Foreign")
            s.add(foreign)
            await s.commit()
        body = dict(action_key=KEY, level="ask", project_id=str(d["project_id"]))
        for who, kw, expected, code in (
            (d["agent_id"], {"api_key": True}, 403, "ACTION_POLICY_PERSON_SESSION_REQUIRED"),      # an agent never sets its own policy
            (d["admin_user"], {"human_key": True}, 403, "ACTION_POLICY_PERSON_SESSION_REQUIRED"),  # a personal key
            (d["member_user"], {}, 403, "ACTION_POLICY_ADMIN_REQUIRED"),                           # a plain member
            (d["admin_user"], {}, 200, None),
        ):
            await _act_as(app, Session, who, d["org_id"], **kw)
            async with _client_for(app) as c:
                r = await _put(c, **body)
                assert r.status_code == expected, (who, kw, r.text)
                if code:
                    assert r.json()["error"]["code"] == code
                g = await c.get(URL)
                assert g.status_code == expected, "reading is for the same people"
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            assert (await _put(c, action_key=KEY, level="ask", project_id=str(foreign.id))).status_code == 404, "a project of another organisation"
            assert (await _put(c, action_key=KEY, level="ask", agent_id=str(uuid.uuid4()))).status_code == 404, "an agent that is not this organisation's"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_every_change_is_one_audit_row_and_the_old_gate_levels_are_untouched():
    from sqlalchemy import text

    from app.main import app
    from app.services.gate_config import resolve_gate_level, set_gate_level

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            # the old shape: (done × agent) for the organisation, one row — must read exactly as before
            await set_gate_level(s, org_id=d["org_id"], project_id=None, work_type="done", actor_type="agent", level="block", created_by=None)
            await s.commit()
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            r = await _put(c, action_key=KEY, level="auto", project_id=str(d["project_id"]), agent_id=str(d["agent_id"]))
            assert r.status_code == 200, r.text
            assert (await c.delete(URL, params={"action_key": KEY, "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})).json() == {"removed": True}
            assert (await c.delete(URL, params={"action_key": KEY, "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})).json() == {"removed": False}, "nothing left to remove: no second audit row"
            listing = (await c.get(URL, params={"project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})).json()
        async with Session() as s:
            rows = (await s.execute(text("SELECT action, context FROM activity_logs WHERE org_id = :o AND action LIKE 'agent_action_policy.%' ORDER BY created_at"), {"o": d["org_id"]})).all()
            level = await resolve_gate_level(s, org_id=d["org_id"], project_id=d["project_id"], work_type="done", actor_type="agent")
        assert [r[0] for r in rows] == ["agent_action_policy.set", "agent_action_policy.clear"]
        assert rows[0][1]["level_before"] == "ask" and rows[0][1]["level_after"] == "auto"
        assert level == "block", "the old (done × agent) level reads as before — the new rows do not leak into it"
        keys = {a["action_key"]: a for a in listing["actions"]}
        assert keys["story.delete"]["level"] == "ask" and keys["story.delete"]["source"] == "default" and keys["story.delete"]["auto_allowed"] is True
        assert keys["gate.approve"]["locked"] is True and keys["gate.approve"]["level"] == "block"
        assert keys["org.delete"]["auto_allowed"] is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_the_old_gate_levels_road_cannot_write_an_action_row_and_no_floor_action_is_adjustable():
    """codex on this PR: (1) `set_gate_level` — the old (done · merge × actor) road — must not be a way around the action policy's rules: it refuses every work_type that is not `done` / `merge`, so an
    `action:<key>` row (a floor action, an `auto` without a scope) can only be written by `set_action_level`; (2) no action is both adjustable and a floor row (the listing has no duplicates)"""
    import asyncio

    from app.services.agent_action_policy import FLOOR_ACTIONS, adjustable_actions
    from app.services.gate_config import set_gate_level

    async def _try(work_type):
        return await set_gate_level(None, org_id=uuid.uuid4(), project_id=None, work_type=work_type, actor_type="agent", level="auto", created_by=None)  # refused before any database use

    for work_type in ("action:gate.approve", "action:story.delete", "anything"):
        with pytest.raises(ValueError):
            asyncio.run(_try(work_type))
    assert not set(adjustable_actions()) & set(FLOOR_ACTIONS)
    assert len(adjustable_actions()) == len(set(adjustable_actions()))
