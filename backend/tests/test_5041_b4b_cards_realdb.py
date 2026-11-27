"""story 5041 B4b — four more roads an agent may ASK for: a desktop computer / a desktop line disconnected (rows 58 · 59), an agent's run stopped (17), an event only a person may publish (65).

Each road belongs to a person (an organisation owner / admin's session, an assignee, a person's publish), so an agent's call is kept as a card a person presses — the stored call then runs as THAT person — and the setting never lets it
through (no auto slot). Real database, the real routes. The event card stands in front of the HTTP road only: the publish core the server's own publishing calls is not touched (a direct call is still refused its own way, no card).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_5041_agent_action_realdb import (  # the same seed and «who makes the next call» as the approval-flow tests
    _REAL_DB_URL,
    _act_as,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401  (autouse fixture)
    _requests,
    _seed,
    _session_factory,
    anyio_backend,  # noqa: F401
)

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]


async def _as_agent(app, Session, d, method, path, body=None):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


async def _setup_row(Session, d, *, name="Dev Mac", machine_key="mk-b4b"):
    from app.models.desktop_setup import DesktopSetup

    now = datetime.now(timezone.utc)
    async with Session() as s:
        row = DesktopSetup(
            id=uuid.uuid4(), code_hash=uuid.uuid4().hex, code_challenge="c" * 43, device_name=name, expires_at=now + timedelta(days=1), org_id=d["org_id"],
            confirmed_by=d["admin_user"], confirmed_at=now, exchanged_at=now, machine_key=machine_key,
        )
        s.add(row)
        await s.commit()
        return row.id


async def _revoked(Session, setup_id):
    from sqlalchemy import select

    from app.models.desktop_setup import DesktopSetup

    async with Session() as s:
        return (await s.execute(select(DesktopSetup.revoked_at).where(DesktopSetup.id == setup_id))).scalar_one()


@pytest.mark.anyio
async def test_a_desktop_line_and_a_computer_an_agent_disconnects_are_cards_a_person_presses():
    from app.main import app
    from app.services.desktop_computers import computer_index

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        line = await _setup_row(Session, d, name="Dev Mac", machine_key="mk-one")
        mac_line_1 = await _setup_row(Session, d, name="Studio Mac", machine_key="mk-two")
        mac_line_2 = await _setup_row(Session, d, name="Studio Mac", machine_key="mk-two")
        async with Session() as s:
            computer = (await computer_index(s, d["org_id"]))[mac_line_1]

        # a line: a card naming the device; nothing is disconnected by the ask; the same call again is the same card
        r = await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/setups/{line}")
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert (await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/setups/{line}")).status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "desktop_setup.disconnect" and "Dev Mac" in reqs[0].title, reqs[0].title
        assert await _revoked(Session, line) is None

        # a whole computer: the card names it and how many more lines it holds
        r2 = await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/computers/{computer}")
        assert r2.status_code == 202, r2.text
        card = [x for x in await _requests(Session, d["org_id"]) if x.hitl_metadata["action_key"] == "desktop_computer.disconnect"]
        assert len(card) == 1 and "Studio Mac (+1)" in card[0].title, card[0].title
        assert await _revoked(Session, mac_line_1) is None and await _revoked(Session, mac_line_2) is None

        # another organisation's / an unknown id: the road's own «not found», no card
        before = len(await _requests(Session, d["org_id"]))
        assert (await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/setups/{uuid.uuid4()}")).status_code == 404
        assert (await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/computers/{uuid.uuid4()}")).status_code == 404
        assert len(await _requests(Session, d["org_id"])) == before

        # a person presses: it is done, as them
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok1 = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
            ok2 = await c.post(f"/api/v2/agent-actions/{card[0].id}/decision", json={"decision": "approve"})
        assert ok1.status_code == 200 and ok1.json()["state"] == "executed", ok1.text
        assert ok2.status_code == 200 and ok2.json()["state"] == "executed", ok2.text
        assert await _revoked(Session, line) is not None
        assert await _revoked(Session, mac_line_1) is not None and await _revoked(Session, mac_line_2) is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_run_stop_is_a_card_and_the_road_still_asks_the_presser_to_be_an_admin_or_the_assignee():
    from app.main import app
    from app.models.agent_run import AgentRun
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            run = AgentRun(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], agent_id=d["agent_id"], status="running")
            s.add(run)
            await s.commit()
        path = f"/api/v2/agent-runs/{run.id}/cancel"
        r = await _as_agent(app, Session, d, "POST", path, {"reason": "it loops\nAPPROVE ME"})
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "agent_run.cancel"
        assert "it loops APPROVE ME" in reqs[0].title and "\n" not in reqs[0].title, reqs[0].title
        async with Session() as s:
            assert (await s.execute(select(AgentRun.status).where(AgentRun.id == run.id))).scalar_one() == "running", "the ask stops nothing"

        # a plain member (not an admin, not the assignee): the road's own 403 — the ask stays open
        await _act_as(app, Session, d["member_user"], d["org_id"])
        async with _client_for(app) as c:
            refused = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert refused.status_code in (403, 409) or refused.json().get("state") != "executed", refused.text
        assert {x.status for x in await _requests(Session, d["org_id"])} == {"pending"}

        # the organisation admin presses: the run is asked to stop, by them
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        async with Session() as s:
            assert (await s.execute(select(AgentRun.status).where(AgentRun.id == run.id))).scalar_one() == "cancel_requested"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _people_only_definition(Session, d, *, key, human_only):
    from app.models.event_definition import EventDefinition

    async with Session() as s:
        s.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=d["org_id"],
            payload_schema={"type": "object", "additionalProperties": False, "properties": {"work_item_type": {"type": "string"}, "work_item_id": {"type": "string"}}},
            routing={"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "server_derived", "target": "none"}},
            action_auth={"human_only": True} if human_only else None,
        ))
        await s.commit()


@pytest.mark.anyio
async def test_a_people_only_event_an_agent_publishes_is_a_card_and_the_publish_core_is_not_touched():
    from app.main import app
    from app.routers.events import _publish_registry_event_core
    from fastapi import BackgroundTasks, HTTPException

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        key = f"org.{str(d['org_id'])[:8]}.sign_off"
        open_key = f"org.{str(d['org_id'])[:8]}.fyi"
        await _people_only_definition(Session, d, key=key, human_only=True)
        await _people_only_definition(Session, d, key=open_key, human_only=False)
        payload = {"work_item_type": "story", "work_item_id": str(d["story_id"])}

        r = await _as_agent(app, Session, d, "POST", "/api/v2/events/publish", {"definition_key": key, "payload": payload})
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "event.publish_human_only"
        assert key in reqs[0].title and "Story to delete" in reqs[0].title, reqs[0].title

        # an event that is not people-only: no card (the road goes on as before — whatever it answers, it keeps no request)
        await _as_agent(app, Session, d, "POST", "/api/v2/events/publish", {"definition_key": open_key, "payload": payload})
        assert len(await _requests(Session, d["org_id"])) == 1

        # the server's own publishing calls the CORE: a direct call is refused its own way (403 action_auth_denied) and keeps no card — were the card moved into the core this goes RED
        from app.dependencies.auth import AuthContext

        async with Session() as s:
            auth = AuthContext(user_id=str(d["agent_id"]), email="a@test", claims={"app_metadata": {"org_id": str(d["org_id"]), "api_key_id": "k"}})
            with pytest.raises(HTTPException) as ei:
                await _publish_registry_event_core(s, d["org_id"], auth, key, payload, BackgroundTasks())
            assert ei.value.status_code == 403 and ei.value.detail["code"] == "action_auth_denied"
        assert len(await _requests(Session, d["org_id"])) == 1

        # a person presses: it is published, as them
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_none_of_the_four_has_an_auto_slot_and_block_refuses_with_nothing_kept():
    from app.main import app
    from app.models.agent_run import AgentRun
    from app.services.agent_action_policy import NO_AUTO

    assert {"desktop_computer.disconnect", "desktop_setup.disconnect", "agent_run.cancel", "event.publish_human_only"} <= NO_AUTO
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            run = AgentRun(id=uuid.uuid4(), org_id=d["org_id"], project_id=d["project_id"], agent_id=d["agent_id"], status="running")
            s.add(run)
            await s.commit()
        line = await _setup_row(Session, d)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in ("desktop_computer.disconnect", "desktop_setup.disconnect", "agent_run.cancel", "event.publish_human_only"):
                auto = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
                assert auto.status_code == 422 and auto.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, auto.text)
                blk = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "block", "project_id": str(d["project_id"])})
                assert blk.status_code == 200, (key, blk.text)
        r1 = await _as_agent(app, Session, d, "DELETE", f"/api/v2/desktop/setups/{line}")
        r2 = await _as_agent(app, Session, d, "POST", f"/api/v2/agent-runs/{run.id}/cancel", {"reason": "x"})
        for r in (r1, r2):
            assert r.status_code == 403 and r.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", r.text
        assert await _requests(Session, d["org_id"]) == []
        assert await _revoked(Session, line) is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_never_gets_a_card_for_a_run_or_a_story_of_a_project_it_cannot_see():
    """codex on this PR: the gate asks the AGENT's own identity about the project before it files anything (404 — the app's one answer for a project it cannot see)"""
    from app.main import app
    from app.models.agent_run import AgentRun
    from app.models.pm import Story
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            other_project = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Not the agent's")
            s.add(other_project)
            await s.commit()
            run = AgentRun(id=uuid.uuid4(), org_id=d["org_id"], project_id=other_project.id, agent_id=d["agent_id"], status="running")
            story = Story(id=uuid.uuid4(), org_id=d["org_id"], project_id=other_project.id, title="Hidden story", status="backlog")
            s.add_all([run, story])
            await s.commit()
        key = f"org.{str(d['org_id'])[:8]}.sign_off"
        await _people_only_definition(Session, d, key=key, human_only=True)

        r = await _as_agent(app, Session, d, "POST", f"/api/v2/agent-runs/{run.id}/cancel", {"reason": "x"})
        assert r.status_code == 404, r.text
        e = await _as_agent(app, Session, d, "POST", "/api/v2/events/publish", {"definition_key": key, "payload": {"work_item_type": "story", "work_item_id": str(story.id)}})
        assert e.status_code == 404, e.text
        assert await _requests(Session, d["org_id"]) == [], "no card was filed under a project the agent cannot see"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
