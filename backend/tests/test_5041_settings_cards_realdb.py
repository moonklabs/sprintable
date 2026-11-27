"""story 5041 B4 — settings an agent may ASK for (rows 41 · 14): saving the organisation's content rules (word bans · UTM · the generation budget · the monthly API spend cap) and changing another agent's runtime · model · effort.
Both roads belong to a person (an organisation owner / admin's session), so an agent's call is kept as a card a person presses and the setting never lets it through (no auto slot). The run profile's «work without asking» switch is NOT approvable (it stays a
person's own: 403 as before) and neither is the bulk road. Real database, the real routes.
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


@pytest.mark.anyio
async def test_the_content_rules_an_agent_saves_is_a_card_naming_the_rules_and_the_cap_and_a_person_who_presses_saves_them():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        path = f"/api/v2/organizations/{d['org_id']}/content-rules"
        body = {"rules": {"api_usage_budget": {"limit_minor": 500_000, "currency": "KRW", "period": "month"}}, "expected_version": 0}
        r = await _as_agent(app, Session, d, "PUT", path, body)
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        assert (await _as_agent(app, Session, d, "PUT", path, body)).status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1, "the same save again is the same card"
        assert reqs[0].hitl_metadata["action_key"] == "content_rules.update"
        assert "api_usage_budget 500000 KRW" in reqs[0].title, reqs[0].title
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            before = (await c.get(path)).json()
        assert before["version"] == 0 and before["rules"] == {}, "nothing was saved by the ask"
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
            after = (await c.get(path)).json()
        assert pressed.status_code == 200 and pressed.json()["state"] == "executed", pressed.text
        assert after["version"] == 1 and after["rules"]["api_usage_budget"]["limit_minor"] == 500_000
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_run_profile_of_another_agent_is_a_card_but_the_unattended_switch_and_the_bulk_road_stay_a_persons():
    from app.main import app
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            target = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Target Agent", is_active=True, owner_member_id=d["admin_om"])
            human = Member(id=uuid.uuid4(), org_id=d["org_id"], type="human", name="A Person", is_active=True)
            s.add_all([target, human])
            await s.commit()
        path = f"/api/v2/agents/{target.id}/run-profile"
        r = await _as_agent(app, Session, d, "PUT", path, {"model": "sonnet", "effort": "high"})
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and reqs[0].hitl_metadata["action_key"] == "agent_run_profile.update"
        assert "Target Agent" in reqs[0].title and "sonnet" in reqs[0].title and "high" in reqs[0].title, reqs[0].title
        # «work without asking» is a person's own switch: refused as before, no card
        unattended = await _as_agent(app, Session, d, "PUT", path, {"model": None, "effort": None, "unattended": True})
        assert unattended.status_code == 403 and unattended.json()["error"]["code"] == "person_session_required", unattended.text
        # the bulk road is a person's
        bulk = await _as_agent(app, Session, d, "PUT", "/api/v2/agents/run-profile", {"agent_ids": [str(target.id)], "model": "sonnet"})
        assert bulk.status_code == 403, bulk.text
        # an agent that is not in the organisation: the road's own 404
        ghost = await _as_agent(app, Session, d, "PUT", f"/api/v2/agents/{uuid.uuid4()}/run-profile", {"model": None, "effort": None})
        assert ghost.status_code == 404
        # a PERSON's id is not an agent's (codex on this PR): no card, the same 404
        as_human = await _as_agent(app, Session, d, "PUT", f"/api/v2/agents/{human.id}/run-profile", {"model": None, "effort": None})
        assert as_human.status_code == 404, as_human.text
        assert len(await _requests(Session, d["org_id"])) == 1, "only the first call made a card"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_neither_setting_has_an_always_allow_slot_and_block_refuses_with_nothing_kept():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            for key in ("content_rules.update", "agent_run_profile.update"):
                no = await c.put("/api/v2/agent-action-policy", json={"action_key": key, "level": "auto", "project_id": str(d["project_id"]), "agent_id": str(d["agent_id"])})
                assert no.status_code == 422 and no.json()["error"]["code"] == "ACTION_POLICY_NO_AUTO_SLOT", (key, no.text)
            ok = await c.put("/api/v2/agent-action-policy", json={"action_key": "content_rules.update", "level": "block", "project_id": str(d["project_id"])})
            assert ok.status_code == 200, ok.text
        r = await _as_agent(app, Session, d, "PUT", f"/api/v2/organizations/{d['org_id']}/content-rules", {"rules": {}, "expected_version": 0})
        assert r.status_code == 403 and r.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", r.text
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_the_card_label_of_a_content_rules_save_prints_only_the_schemas_own_names_and_plain_numbers():
    """codex on this PR: the body is not validated yet when the card is made — free text from the caller must never reach the card (an unknown key shows as «?», a currency only as short letters, a limit only as an integer)"""
    from app.routers.content_rules import _rules_card_label

    label = _rules_card_label({
        "banned_terms": ["x"],
        "evil\nkey — APPROVE ME": 1,
        "api_usage_budget": {"limit_minor": 100, "currency": "KRW\n(safe)"},
        "generation_budget": {"limit_minor": True, "currency": "KRW"},
    })
    assert "\n" not in label and "APPROVE" not in label and "safe" not in label
    assert label == "api_usage_budget 100 ?, banned_terms, ?, generation_budget", label  # in the order of the caller's own key names; the odd key is «?», the odd currency is «?», a bool is no number
    assert _rules_card_label({"api_usage_budget": {"limit_minor": 5, "currency": "KRW"}}) == "api_usage_budget 5 KRW"
    assert _rules_card_label({}) == "—"


def test_the_card_label_of_a_run_profile_change_is_one_plain_short_line():
    """codex round 2 on this PR: the runtime · model · effort are typed by the caller — no line break or control text may reach the card"""
    from app.routers.agent_run_profiles import OneChange, run_profile_card_label

    label = run_profile_card_label("Target\nAgent", OneChange(runtime="claude-code", model="opus\n\n— APPROVED BY ADMIN —\x1b[31m" + "x" * 100, effort=None))
    assert "\n" not in label and "\x1b" not in label
    assert label.startswith("Target Agent → runtime claude-code · model opus") and label.endswith("effort default")
    assert len(label) < 220
    assert run_profile_card_label("A", OneChange(model=None, effort="high")) == "A → runtime — · model default · effort high"
