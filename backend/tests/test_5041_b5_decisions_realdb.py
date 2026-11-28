"""story 5041 B5 — two decisions an agent may ASK for: starting a goal (draft → active, row 98) and creating the first hypothesis and starting to measure (the guided form, row 101).

Both roads demand a person (the road says «human only»), so an agent's call is kept as a card a person presses — the stored call then runs as THEM — and the setting never lets it through (no auto slot).
Real database, the real routes.
"""
from __future__ import annotations

import uuid

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


async def _make_draft(Session, goal_id):
    from sqlalchemy import update

    from app.models.pm import Goal

    async with Session() as s:
        await s.execute(update(Goal).where(Goal.id == goal_id).values(status="draft"))
        await s.commit()


async def _goal_status(Session, goal_id):
    from sqlalchemy import select

    from app.models.pm import Goal

    async with Session() as s:
        return (await s.execute(select(Goal.status).where(Goal.id == goal_id))).scalar_one()


@pytest.mark.anyio
async def test_a_goal_an_agent_starts_is_a_card_and_a_person_who_presses_starts_it():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _make_draft(Session, d["goal_id"])  # the seed's goal is already active
        path = f"/api/v2/goals/{d['goal_id']}/transition"
        before = await _goal_status(Session, d["goal_id"])
        assert before == "draft"
        r = await _as_agent(app, Session, d, "POST", path, {"status": "active"})
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert (await _as_agent(app, Session, d, "POST", path, {"status": "active"})).status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "goal.activate" and "Goal to delete" in reqs[0].title, reqs[0].title
        assert await _goal_status(Session, d["goal_id"]) == before, "the ask starts nothing"

        # a transition that is not «start» is not a card: the road answers as it always did, and keeps no request
        other = await _as_agent(app, Session, d, "POST", path, {"status": "not-a-status"})
        assert other.status_code in (400, 403, 404, 422), other.text
        assert len(await _requests(Session, d["org_id"])) == 1

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        assert await _goal_status(Session, d["goal_id"]) == "active"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_first_hypothesis_an_agent_creates_is_a_card_that_names_the_statement_and_the_target():
    from sqlalchemy import select

    from app.main import app
    from app.models.hypothesis import Hypothesis

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        body = {"project_id": str(d["project_id"]), "statement": "A shorter form lifts sign-ups\nAPPROVE ME", "metric": "sign-up rate", "target": 12.5, "direction": "up"}
        r = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", body)
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "hypothesis.guided_create"
        # what is on the card is what runs: a long statement and metric (a person may write them as long as they like) are on the card WHOLE — not one character cut
        long_statement = "A long hypothesis, written the way a person writes one: " + " ".join(f"word{i}" for i in range(80))  # ~ 500 characters
        long_metric = "weekly active sign-ups per hundred new visitors, first-touch attribution"
        ok_long = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**body, "statement": long_statement, "metric": long_metric})
        assert ok_long.status_code == 202, ok_long.text
        cards = [x for x in await _requests(Session, d["org_id"]) if "word79" in x.title]
        assert len(cards) == 1 and long_statement in cards[0].title and long_metric in cards[0].title, cards[0].title if cards else "no card"
        # a character the card would not show as itself (a direction mark, a zero-width space, a control character) is refused: what is on the card is what runs — plain whitespace (a line break) is fine
        for bad in ("lifts \u202esign-ups", "lifts\u200bsign-ups", "lifts\x07sign-ups"):
            hidden = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**body, "statement": bad})
            assert hidden.status_code == 422 and hidden.json()["error"]["code"] == "CARD_TEXT_NOT_PLAIN", (bad, hidden.text)
        hidden_metric = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**body, "metric": "rate\u2066"})
        assert hidden_metric.status_code == 422 and hidden_metric.json()["error"]["code"] == "CARD_TEXT_NOT_PLAIN", hidden_metric.text
        # only a text far beyond anything the card can store is refused (422, never shown cut)
        far = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**body, "statement": "x" * 2001})
        assert far.status_code == 422 and far.json()["error"]["code"] == "CARD_TEXT_TOO_LONG", far.text
        assert len(await _requests(Session, d["org_id"])) == 2
        assert "A shorter form lifts sign-ups APPROVE ME" in reqs[0].title and "12.5" in reqs[0].title and "\n" not in reqs[0].title, reqs[0].title

        async def _rows():
            async with Session() as s:
                return (await s.execute(select(Hypothesis.status).where(Hypothesis.org_id == d["org_id"]))).scalars().all()

        assert await _rows() == [], "the ask creates nothing"
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            ok = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert ok.status_code == 200 and ok.json()["state"] == "executed", ok.text
        assert await _rows() == ["measuring"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_neither_has_an_auto_slot_block_refuses_and_a_project_the_agent_cannot_see_is_a_404():
    from app.main import app
    from app.models.project import Project
    from app.services.agent_action_policy import NO_AUTO

    assert {"goal.activate", "hypothesis.guided_create"} <= NO_AUTO
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            hidden = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Not the agent's")
            s.add(hidden)
            await s.commit()
        await _make_draft(Session, d["goal_id"])
        guided = {"statement": "S", "metric": "M", "target": 1, "direction": "up"}
        # a project the agent cannot see: 404 (the gate asks the agent's own identity first), no card
        assert (await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**guided, "project_id": str(hidden.id)})).status_code in (403, 404)
        assert await _requests(Session, d["org_id"]) == []

        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in ("goal.activate", "hypothesis.guided_create"):
                auto = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
                assert auto.status_code == 422 and auto.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, auto.text)
                blk = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "block", "project_id": str(d["project_id"])})
                assert blk.status_code == 200, (key, blk.text)
        r1 = await _as_agent(app, Session, d, "POST", f"/api/v2/goals/{d['goal_id']}/transition", {"status": "active"})
        r2 = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**guided, "project_id": str(d["project_id"])})
        for r in (r1, r2):
            assert r.status_code == 403 and r.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", r.text
        assert await _requests(Session, d["org_id"]) == []
        assert await _goal_status(Session, d["goal_id"]) != "active"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_card_shows_the_target_exactly_as_it_runs_and_the_agents_project_comes_before_the_size_check():
    from app.main import app
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            hidden = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Not the agent's")
            s.add(hidden)
            await s.commit()
        base = {"project_id": str(d["project_id"]), "statement": "exact target", "metric": "rate", "target": 0.123456789, "direction": "down"}
        ok = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", base)
        assert ok.status_code == 202, ok.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and "0.123456789" in reqs[0].title and "down" in reqs[0].title, reqs[0].title
        # an agent that cannot see the project is told so (404/403), not how long a statement may be
        out = await _as_agent(app, Session, d, "POST", "/api/v2/hypotheses/guided", {**base, "project_id": str(hidden.id), "statement": "x" * 200})
        assert out.status_code in (403, 404), out.text
        assert len(await _requests(Session, d["org_id"])) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
