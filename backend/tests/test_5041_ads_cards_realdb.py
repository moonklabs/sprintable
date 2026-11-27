"""story 5041 B1 — the ads boost, as an agent meets it (PO 11-27 seq 20558, rows 4 · 5 · 7 · 8 · 10 · 11): money goes out, so what an agent asks for is kept as a card a person presses and then runs AS THE PERSON.

Real database, the real routes. Start · resume · adopt-existing · cancel of an approved boost, and the request for a boost itself (it carries a budget — the card names the amount). Nothing runs until a person presses; the user's setting
(`block` / `auto`) decides otherwise; `auto` runs the call as the agent under its own rights (the road's own checks stay).
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

from tests.test_3806_ads_boost_gate import _configure_secrets  # noqa: F401,E402 — autouse: the channel-credential key the seeded connections need

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="needs a real PG (PARITY/ALEMBIC_DATABASE_URL)")]

POLICY = "/api/v2/agent-action-policy"
GATES = "gate"


async def _world(app, Session, d):
    """a publication on the seed's story, a boost requested by the admin person and approved → (publication id, ad connection id, gate id)"""
    from tests.test_3497_insight_snapshots import _seed_channel_connection
    from tests.test_3806_ads_boost_gate import _approve_gate, _boost_body, _seed_publication
    from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role

    async with Session() as s:
        conn = await _seed_channel_connection(s, d["org_id"], channel="threads")
        ad = await _seed_channel_connection(s, d["org_id"], channel="ads_sandbox")
        await _seed_default_role(s, d["org_id"])
        pub, _ = await _seed_publication(s, org_id=d["org_id"], connection_id=conn.id, work_item_id=d["story_id"])
    await _act_as(app, Session, d["admin_user"], d["org_id"])
    async with _client_for(app) as c:
        r = await c.post(f"/api/v2/organizations/{d['org_id']}/publications/{pub.id}/boosts", json=_boost_body(ad_connection_id=ad.id))
    assert r.status_code == 201, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    async with Session() as s:
        await _approve_gate(s, gate_id, d["admin_om"])
    return pub.id, ad.id, gate_id


async def _as_agent(app, Session, d, method, path, body=None):
    await _act_as(app, Session, d["agent_id"], d["org_id"], api_key=True)
    async with _client_for(app) as c:
        return await c.request(method, path, json=body) if body is not None else await c.request(method, path)


async def _commands(Session, gate_id):
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text("SELECT operation, initiated_by FROM publication_commands WHERE gate_id = :g ORDER BY created_at"), {"g": gate_id})).all()


async def _set(app, Session, d, **body):
    await _act_as(app, Session, d["admin_user"], d["org_id"])
    async with _client_for(app) as c:
        r = await c.put(POLICY, json=body)
    assert r.status_code == 200, r.text


@pytest.mark.anyio
@pytest.mark.parametrize("key, suffix", [("ads_boost.start", "start"), ("ads_boost.resume", "resume"), ("ads_boost.adopt", "adopt-existing"), ("ads_boost.cancel", "cancel")])
async def test_an_agents_call_on_an_approved_boost_is_a_card_naming_the_amount_and_nothing_runs(key, suffix):
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        _pub, _ad, gate_id = await _world(app, Session, d)
        path = f"/api/v2/organizations/{d['org_id']}/ads-boosts/{gate_id}/{suffix}"
        r = await _as_agent(app, Session, d, "POST", path)
        assert r.status_code == 202 and r.json()["status"] == "pending_approval", r.text
        again = await _as_agent(app, Session, d, "POST", path)
        assert again.status_code == 202
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1, "the same call again is the same card"
        assert reqs[0].hitl_metadata["action_key"] == key and reqs[0].hitl_metadata["snapshot"]["path"] == path
        assert "100,000 KRW" in reqs[0].title and "~" in reqs[0].title, reqs[0].title  # the amount · the ad account · the schedule (what the sealed request carries that moves money)
        assert await _commands(Session, gate_id) == [], "nothing was queued for the ad account"
        async with Session() as s:
            assert (await s.execute(select(Gate.status).where(Gate.id == gate_id))).scalar_one() == "approved", "and the boost is as it was"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pressing_the_start_card_runs_it_as_the_person_and_pressing_the_cancel_card_voids_the_boost():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        _pub, _ad, gate_id = await _world(app, Session, d)
        base = f"/api/v2/organizations/{d['org_id']}/ads-boosts/{gate_id}"
        start = (await _as_agent(app, Session, d, "POST", f"{base}/start")).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{start}/decision", json={"decision": "approve"})
        assert pressed.status_code == 200 and pressed.json()["state"] == "executed", pressed.text
        assert [(op, by) for op, by in await _commands(Session, gate_id)] == [("boost_start", "human")], "it ran as a person's start"
        cancel = (await _as_agent(app, Session, d, "POST", f"{base}/cancel")).json()["request_id"]
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            done = await c.post(f"/api/v2/agent-actions/{cancel}/decision", json={"decision": "approve"})
        assert done.status_code == 200 and done.json()["state"] == "executed", done.text
        async with Session() as s:
            assert (await s.execute(select(Gate.status).where(Gate.id == gate_id))).scalar_one() == "voided"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_users_setting_decides_block_refuses_with_nothing_kept_and_auto_runs_as_the_agent_under_its_own_rights():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        _pub, _ad, gate_id = await _world(app, Session, d)
        base = f"/api/v2/organizations/{d['org_id']}/ads-boosts/{gate_id}"
        await _set(app, Session, d, action_key="ads_boost.start", level="block", project_id=str(d["project_id"]))
        blocked = await _as_agent(app, Session, d, "POST", f"{base}/start")
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "AGENT_ACTION_BLOCKED", blocked.text
        assert await _requests(Session, d["org_id"]) == [] and await _commands(Session, gate_id) == []

        await _set(app, Session, d, action_key="ads_boost.start", level="auto", project_id=str(d["project_id"]), agent_id=str(d["agent_id"]))
        auto = await _as_agent(app, Session, d, "POST", f"{base}/start")
        assert auto.status_code == 201, auto.text
        assert [op for op, _by in await _commands(Session, gate_id)] == ["boost_start"]
        assert await _requests(Session, d["org_id"]) == [], "no card: the user said this agent may, in this project"
        # `auto` is one action: another action of the same boost still asks
        cancel = await _as_agent(app, Session, d, "POST", f"{base}/cancel")
        assert cancel.status_code == 202
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agents_boost_request_is_a_card_with_the_budget_and_pressing_it_makes_the_gate_as_the_person():
    from app.main import app
    from sqlalchemy import text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
        from tests.test_3497_insight_snapshots import _seed_channel_connection
        from tests.test_3806_ads_boost_gate import _boost_body, _seed_publication
        from tests.test_e4fc29fa_site_post_orchestration import _seed_default_role

        async with Session() as s:
            conn = await _seed_channel_connection(s, d["org_id"], channel="threads")
            ad = await _seed_channel_connection(s, d["org_id"], channel="ads_sandbox")
            await _seed_default_role(s, d["org_id"])
            pub, _ = await _seed_publication(s, org_id=d["org_id"], connection_id=conn.id, work_item_id=d["story_id"])
        path = f"/api/v2/organizations/{d['org_id']}/publications/{pub.id}/boosts"
        body = _boost_body(ad_connection_id=ad.id, budget_minor=250_000)
        r = await _as_agent(app, Session, d, "POST", path, body)
        assert r.status_code == 202, r.text
        reqs = await _requests(Session, d["org_id"])
        assert len(reqs) == 1 and "250,000 KRW" in reqs[0].title and reqs[0].hitl_metadata["action_key"] == "ads_boost.request"
        assert body["starts_at"][:10] in reqs[0].title and body["ends_at"][:10] in reqs[0].title, "the schedule the person approves is on the card"
        async with Session() as s:
            assert (await s.execute(text(f"SELECT count(*) FROM {GATES} WHERE org_id = :o AND gate_type = 'ads_boost'"), {"o": d["org_id"]})).scalar_one() == 0, "no gate yet"
        # a request that is not well-formed is refused before any card is made
        bad = await _as_agent(app, Session, d, "POST", path, {**body, "currency": "XYZ"})
        assert bad.status_code == 422 and len(await _requests(Session, d["org_id"])) == 1
        await _act_as(app, Session, d["admin_user"], d["org_id"])
        async with _client_for(app) as c:
            pressed = await c.post(f"/api/v2/agent-actions/{reqs[0].id}/decision", json={"decision": "approve"})
        assert pressed.status_code == 200 and pressed.json()["state"] == "executed", pressed.text
        async with Session() as s:
            row = (await s.execute(text(f"SELECT status, sealed_ads_budget_minor FROM {GATES} WHERE org_id = :o AND gate_type = 'ads_boost'"), {"o": d["org_id"]})).one()
        assert tuple(row) == ("pending", 250_000), "the gate is made, awaiting its approval — as the person's request"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_that_cannot_see_the_boosts_project_gets_the_same_404_as_a_boost_that_is_not_there():
    from app.main import app
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            d = await _seed(s)
            outsider = Member(id=uuid.uuid4(), org_id=d["org_id"], type="agent", name="Outsider", is_active=True, owner_member_id=d["admin_om"])
            p2 = Project(id=uuid.uuid4(), org_id=d["org_id"], name="Elsewhere")
            s.add_all([outsider, p2])
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=p2.id, member_id=outsider.id, permission="granted", role="member"))  # a member of ANOTHER project: it resolves, and cannot see this one
            await s.commit()
        _pub, _ad, gate_id = await _world(app, Session, d)
        await _act_as(app, Session, outsider.id, d["org_id"], api_key=True)
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/organizations/{d['org_id']}/ads-boosts/{gate_id}/start")
            ghost = await c.post(f"/api/v2/organizations/{d['org_id']}/ads-boosts/{uuid.uuid4()}/start")
        assert r.status_code == 404 and ghost.status_code == 404, (r.text, ghost.text)
        assert await _requests(Session, d["org_id"]) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
