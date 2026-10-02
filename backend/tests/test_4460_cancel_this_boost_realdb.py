"""story #4460 — a person cancels a boost; the next request for the same post starts a new cycle with a new campaign.

PO 10:56Z · 16:30Z · 16:32Z: a post has one ads_boost gate and a gate one run, so a cancel resets them in place. The gate is voided
the moment the cancel is asked for (an explicit ads_boost cancel transition, with who and why on the gate) — 4466's rules then
stop the money (start/resume refused · a live campaign paused). The run is cleared only once the provider confirmed the campaign
is off (paused, or never switched on, and no command still out): until then it is «취소 중» and keeps every campaign id (an
emptied run could neither stop nor read a live campaign). The ended cycle is kept as a row (campaign · created values · spend).
A re-request then reopens the gate as a fresh cycle; the next start makes a new campaign. Requester or owner/admin only.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_gate import _approve_gate, _boost_body
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _start_command, _tick
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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



def _provider(monkeypatch) -> list[tuple[str, str]]:
    """Every status call the sandbox gets, as (status, campaign id)."""
    import app.services.ads_sandbox_campaign as sandbox

    real = sandbox.set_campaign_status
    calls: list[tuple[str, str]] = []

    async def spy(client, **kwargs):
        calls.append((kwargs["status"], kwargs["campaign_id"]))
        return await real(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", spy)
    return calls


async def _setup(monkeypatch, *, objective="POST_ENGAGEMENT"):
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory(), objective=objective)
    return engine, Session, org_id, owner_id, gate_id, _provider(monkeypatch)


async def _cancel(Session, org_id, gate_id, actor_id, *, is_admin=True, reason="다른 예산으로 다시"):
    from app.services.ads_boost_cancel import cancel_ads_boost

    async with Session() as s:
        result = await cancel_ads_boost(s, org_id=org_id, gate_id=gate_id, actor_member_id=actor_id, actor_is_admin=is_admin, reason=reason)
        await s.commit()
        return result


async def _gate(Session, gate_id):
    from sqlalchemy import select

    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()


async def _cycles(Session, gate_id):
    from sqlalchemy import select

    from app.models.ads_boost_run import AdsBoostRunCycle

    async with Session() as s:
        return (await s.execute(select(AdsBoostRunCycle).where(AdsBoostRunCycle.gate_id == gate_id))).scalars().all()


async def _request_again(Session, org_id, owner_id, gate_id, *, budget_minor):
    from app.main import app

    gate = await _gate(Session, gate_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client:
            return await client.post(
                f"/api/v2/organizations/{org_id}/publications/{gate.scope_key}/boosts",
                json=_boost_body(ad_connection_id=gate.sealed_ads_connection_id, budget_minor=budget_minor),
            )
    finally:
        app.dependency_overrides.clear()


async def _new_seal_start(Session, org_id, gate_id, owner_id):
    from tests.test_4458_seal_race_realdb import _new_seal_start as start

    return await start(Session, org_id, gate_id, owner_id)


async def test_cancel_a_running_boost_then_a_new_request_makes_a_new_campaign(monkeypatch):
    """AC1 · AC3: running → cancel → the gate is voided at once (who · why) and the campaign is paused → only then the cycle is
    recorded and the run cleared → a request with another (higher) budget opens a fresh cycle → its start creates a new campaign;
    the old campaign is never switched on again."""
    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        old = await _run(Session, gate_id)
        assert old.status == "running" and old.campaign_id
        old_campaign = old.campaign_id

        await _cancel(Session, org_id, gate_id, owner_id)
        gate = await _gate(Session, gate_id)
        assert gate.status == "voided" and gate.resolution_note and "다른 예산으로 다시" in gate.resolution_note
        cancelling = await _run(Session, gate_id)
        assert cancelling.cancel_requested_at is not None and cancelling.campaign_id == old_campaign  # «취소 중» · ids kept

        await _tick(Session)  # the pause goes out and lands
        assert calls[-1] == ("PAUSED", old_campaign)
        cleared = await _run(Session, gate_id)
        assert (cleared.campaign_id, cleared.adset_id, cleared.ad_id, cleared.cancel_requested_at) == (None, None, None, None)
        [cycle] = await _cycles(Session, gate_id)
        assert (cycle.campaign_id, cycle.end_reason, cycle.ended_by_member_id) == (old_campaign, "cancelled", owner_id)

        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)  # higher than before: a fresh cycle
        assert r.status_code in (200, 201), r.text
        gate = await _gate(Session, gate_id)
        assert (gate.status, gate.sealed_ads_budget_minor) == ("pending", 250_000) and gate.requested_by_member_id is not None
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        new = await _run(Session, gate_id)
        assert new.status == "running" and new.campaign_id and new.campaign_id != old_campaign
        assert ("ACTIVE", old_campaign) not in calls[calls.index(("PAUSED", old_campaign)):]
        assert new.cycle_started_at is not None
    finally:
        await engine.dispose()


async def test_a_pause_not_confirmed_keeps_the_ids_and_a_new_request_waits(monkeypatch):
    """Condition 1: the pause is in flight (the sandbox's delayed pause) → «취소 중», nothing cleared, no cycle row yet, and a new
    request for the post is refused (409) until it is."""
    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch, objective="POST_ENGAGEMENT [sandbox:pause-delayed]")
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        campaign = (await _run(Session, gate_id)).campaign_id
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert (run.status, run.campaign_id) == ("pause_pending", campaign) and run.cancel_requested_at is not None
        assert await _cycles(Session, gate_id) == []
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_CANCEL_IN_PROGRESS"
    finally:
        await engine.dispose()


async def test_a_cancel_while_the_start_is_out_at_the_provider_waits_for_it_and_never_switches_it_on(monkeypatch):
    """PO 16:32Z: the cancel lands while the start's create call is out (in_progress · outcome unknown). The campaign that call
    makes is never switched on (the gate is no longer approved right before ACTIVE); only after that command ended is the cycle
    recorded (with that campaign) and the run cleared."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    real_create = sandbox.create_boost_campaign
    seen: dict = {}

    async def create_while_cancelled(client, **kwargs):
        result = await real_create(client, **kwargs)
        seen["campaign"] = result["campaign_id"]
        seen["cancel"] = await _cancel(Session, org_id, gate_id, owner_id)  # the person cancels while the call is out
        run = await _run(Session, gate_id)
        seen["kept"] = run.cancel_requested_at is not None and not await _cycles(Session, gate_id)
        return result

    monkeypatch.setattr(sandbox, "create_boost_campaign", create_while_cancelled)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert seen["kept"]  # in flight: «취소 중», nothing recorded yet
        assert [c for c in calls if c[0] == "ACTIVE"] == []  # never switched on
        cleared = await _run(Session, gate_id)
        assert cleared.campaign_id is None and cleared.cancel_requested_at is None
        [cycle] = await _cycles(Session, gate_id)
        assert cycle.campaign_id == seen["campaign"]
    finally:
        await engine.dispose()


async def test_a_held_needs_check_boost_is_cancelled_at_once_and_a_new_budget_makes_a_new_campaign(monkeypatch):
    """AC3 (the 4458 dead end): the campaign was created on another budget and held (needs_check, never switched on) → cancel →
    its campaign gets a pause first (Qadir 02:22Z ⓐ: a made campaign is cleared only after a landed pause — the run cannot tell a
    never-switched-on campaign from one whose ACTIVE switch went out and failed) → the cycle ends → a request with another budget
    → a new campaign."""
    from tests.test_4458_seal_race_realdb import _reseal_during_create

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    creates, statuses = await _reseal_during_create(monkeypatch, Session, gate_id, new_budget=40_000)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        new = await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        held = await _command(Session, new.id)
        assert held.reason_code == "ADS_BOOST_CREATED_BUDGET_DIFFERS"
        old_campaign = (await _run(Session, gate_id)).campaign_id
        assert await _cancel(Session, org_id, gate_id, owner_id) == {"state": "cancelling"}
        assert (await _run(Session, gate_id)).campaign_id == old_campaign  # kept until the pause lands
        await _tick(Session)
        assert statuses[-1] == "PAUSED"
        cleared = await _run(Session, gate_id)
        assert cleared.campaign_id is None and [c.campaign_id for c in await _cycles(Session, gate_id)] == [old_campaign]
        assert "ACTIVE" not in statuses
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=70_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.status == "running" and run.campaign_id != old_campaign and creates[-1] == 70_000
    finally:
        await engine.dispose()


async def test_only_the_requester_or_an_owner_admin_may_cancel(monkeypatch):
    """AC2: another plain member → 403 (nothing changes); the requester (a plain member) and an owner may."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _seed_human

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        async with Session() as s:
            other = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=other)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/cancel", json={"reason": "x"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 403, r.text
        assert (await _gate(Session, gate_id)).status == "approved"
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/cancel", json={"reason": "다시"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200, r.text
        assert (await _gate(Session, gate_id)).status == "voided"
    finally:
        await engine.dispose()


async def test_the_old_cycles_spend_stays_and_the_new_cycle_counts_from_zero(monkeypatch):
    """Condition 3: the ended cycle keeps what it spent (its row · the org ledger), and the new cycle's card · cap count only
    the new campaign's captures."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.ads_spend_snapshots import get_ads_boost_spend_summary, process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)

    async def spend(client, **kwargs):
        return 12_000

    monkeypatch.setattr(sandbox, "get_campaign_spend_minor", spend)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        from app.main import app

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
            assert r.status_code == 201, r.text
        finally:
            app.dependency_overrides.clear()
        async with Session() as s:
            await process_due_ads_spend_snapshots(s, now=datetime.now(timezone.utc))
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        [cycle] = await _cycles(Session, gate_id)
        assert cycle.spend_minor == 12_000
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            summary = await get_ads_boost_spend_summary(s, org_id=org_id, gate_id=gate_id)
            assert summary["captured_spend_minor"] == 0  # the new cycle has spent nothing yet
            assert [c["spend_minor"] for c in summary["previous_cycles"]] == [12_000]
            ledger = await get_org_ads_cost_summary(s, org_id=org_id)
        assert ledger["captured_spend_minor"] >= 12_000  # the org ledger keeps the old cycle's spend
    finally:
        await engine.dispose()


async def test_the_requester_who_is_a_plain_member_may_cancel(monkeypatch):
    """AC2: the person who requested the boost — not an owner/admin — may cancel it (the gate records who asked)."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _seed_human

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        async with Session() as s:
            member = await _seed_human(s, org_id, role="member")
        r = await _request_again(Session, org_id, member, gate_id, budget_minor=60_000)  # the member asks for it (a re-seal)
        assert r.status_code in (200, 201), r.text
        _setup_org_scoped_app(app, Session, org_id, user_id=member)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/cancel", json={"reason": "내가 요청한 것"})
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200, r.text
        assert (await _gate(Session, gate_id)).status == "voided"
    finally:
        await engine.dispose()


async def test_a_queued_start_is_voided_so_a_held_boost_ends_at_once(monkeypatch):
    """A start queued when the cancel lands would never run (the gate is no longer approved) — it is voided with the cancel, so the
    cancel does not wait for the worker to refuse that start; the held campaign is paused, then the cycle ends."""
    from tests.test_4458_seal_race_realdb import _reseal_during_create

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    await _reseal_during_create(monkeypatch, Session, gate_id, new_budget=40_000)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)  # created on the old budget, the new seal's start not sent yet
        queued = await _new_seal_start(Session, org_id, gate_id, owner_id)  # queued, not run
        result = await _cancel(Session, org_id, gate_id, owner_id)
        assert result == {"state": "cancelling"}  # the held campaign's pause first
        assert (await _command(Session, queued.id)).status == "voided"
        await _tick(Session)
        assert (await _run(Session, gate_id)).campaign_id is None
    finally:
        await engine.dispose()


async def test_the_card_learns_who_may_cancel_and_the_gate_status_from_spend(monkeypatch):
    """Yuna 16:46Z: the button shows only for the requester or an owner/admin (the server's same rule) — /spend says so
    (can_cancel), and says the gate's status so the card knows «취소됨» without reloading the gate."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _seed_human

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)

    async def spend_as(user_id):
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
            assert r.status_code == 200, r.text
            return r.json()
        finally:
            app.dependency_overrides.clear()

    try:
        async with Session() as s:
            other = await _seed_human(s, org_id, role="member")
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        mine = await spend_as(owner_id)
        assert (mine["can_cancel"], mine["gate_status"]) == (True, "approved")
        assert (await spend_as(other))["can_cancel"] is False
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        after = await spend_as(owner_id)
        assert (after["can_cancel"], after["gate_status"], after["cancel_requested"]) == (False, "voided", False)
        assert len(after["previous_cycles"]) == 1 and after["previous_cycles"][0]["started_at"]
    finally:
        await engine.dispose()


async def test_a_failed_pause_request_after_the_cancel_still_answers_cancelling_and_the_scheduler_stops_the_money(monkeypatch, caplog):
    """PO 00:40Z (Qadir lens ①): the cancel is committed before the person's pause is requested. If that request fails with
    anything but «already in that state», the answer is still 200 «cancelling» (not 500 — the cancel stands), the failure is logged
    with its code and the gate, and the money is stopped the other way: the gate left approved, so 4466's hook queued a capture due
    now, the scheduler pauses the campaign there, and the cancel then finishes. Without the hook nothing would pause it."""
    import logging

    import app.services.ads_boost_execution as execution
    from app.main import app
    from tests.test_4466_money_stops_off_approved_realdb import _pauses, _spend_tick

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        campaign = (await _run(Session, gate_id)).campaign_id
        assert campaign

        async def pause_fails(*args, **kwargs):
            raise RuntimeError("provider queue unavailable")

        real_pause = execution.request_ads_boost_pause
        monkeypatch.setattr(execution, "request_ads_boost_pause", pause_fails)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            with caplog.at_level(logging.ERROR, logger="app.services.ads_boost_cancel"):
                async with _client_for(app) as client:
                    r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/cancel", json={})
        finally:
            app.dependency_overrides.clear()
            monkeypatch.setattr(execution, "request_ads_boost_pause", real_pause)  # only the person's request failed
        assert (r.status_code, r.json()) == (200, {"state": "cancelling"}), r.text
        [record] = [x for x in caplog.records if getattr(x, "code", None) == "ADS_BOOST_CANCEL_PAUSE_REQUEST_FAILED"]
        assert record.gate_id == str(gate_id)

        assert (await _gate(Session, gate_id)).status == "voided"
        cancelling = await _run(Session, gate_id)
        assert (cancelling.cancel_requested_at is not None, cancelling.campaign_id) == (True, campaign)
        assert await _pauses(Session, gate_id) == []  # the person's pause never got queued

        await _spend_tick(Session)  # the capture 4466's hook queued when the gate left approved
        assert [(p.initiated_by, p.status) for p in await _pauses(Session, gate_id)] == [("scheduler", "pending")]
        await _tick(Session)
        assert calls[-1] == ("PAUSED", campaign)
        # Yuna 02:20Z · PO — the gate is voided by the cancel, but the history must not say «승인 풀림»: the reason is the cancel
        from sqlalchemy import select

        from app.models.activity_log import ActivityLog

        async with Session() as s:
            paused = (await s.execute(select(ActivityLog).where(
                ActivityLog.entity_id == gate_id, ActivityLog.action == "ads_boost_paused",
            ))).scalars().all()
        assert [(x.context.get("initiated_by"), x.context.get("reason")) for x in paused] == [("scheduler", "cancelled")]
        cleared = await _run(Session, gate_id)
        assert (cleared.campaign_id, cleared.cancel_requested_at) == (None, None)
        [cycle] = await _cycles(Session, gate_id)
        assert (cycle.campaign_id, cycle.end_reason) == (campaign, "cancelled")
    finally:
        await engine.dispose()


# ── Qadir 02:22Z (PO: the root — toggles by an explicit cycle number) ────────────────────────────────────────────────────────
async def _second_cycle(Session, org_id, owner_id, gate_id, *, budget_minor):
    """Cycle 1 runs and is cancelled (paused · recorded · cleared); the post is requested again, approved and started: cycle 2
    runs a new campaign. Returns (old campaign, new campaign)."""
    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    old = (await _run(Session, gate_id)).campaign_id
    await _cancel(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    assert (await _run(Session, gate_id)).campaign_id is None
    r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=budget_minor)
    assert r.status_code in (200, 201), r.text
    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)
    await _new_seal_start(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    run = await _run(Session, gate_id)
    assert run.status == "running" and run.campaign_id and run.campaign_id != old and run.cycle_no == 2
    return old, run.campaign_id


async def test_a_second_cycles_campaign_can_be_paused_by_a_person(monkeypatch):
    """The blocker: cycle 1's last pause (completed) was «the latest toggle», so a person's [중지] on cycle 2's campaign was
    refused as «already paused» while it spent. The toggle now reads its own cycle: the pause goes out and lands."""
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    try:
        _old, new = await _second_cycle(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        async with Session() as s:
            pause = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        assert pause.status == "pending" and pause.ads_boost_cycle == 2
        await _tick(Session)
        assert calls[-1] == ("PAUSED", new) and (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_second_cycles_campaign_is_paused_at_its_cap(monkeypatch):
    """The cap's automatic pause takes the same toggle path: cycle 2 (budget 10,000 · the sandbox's capture 12,345) reaches its
    cap and the scheduler's pause stops the new campaign."""
    from app.services.ads_spend_snapshots import refresh_ads_boost_spend_now

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    try:
        _old, new = await _second_cycle(Session, org_id, owner_id, gate_id, budget_minor=10_000)
        async with Session() as s:
            await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        run = await _run(Session, gate_id)
        assert run.cap_reached_at is not None
        await _tick(Session)
        assert calls[-1] == ("PAUSED", new) and (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_second_cycle_can_be_cancelled_too(monkeypatch):
    """Cycle 2's cancel used to be stuck at «취소 중» (its pause refused): now its campaign is paused and the second cycle is
    recorded next to the first."""
    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    try:
        old, new = await _second_cycle(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert await _cancel(Session, org_id, gate_id, owner_id) == {"state": "cancelling"}
        await _tick(Session)
        assert calls[-1] == ("PAUSED", new)
        run = await _run(Session, gate_id)
        assert (run.campaign_id, run.cancel_requested_at, run.cycle_no) == (None, None, 3)
        assert [c.campaign_id for c in await _cycles(Session, gate_id)] == [old, new]
    finally:
        await engine.dispose()


async def test_a_start_whose_active_switch_went_out_and_failed_is_paused_before_the_cancel_clears_it(monkeypatch):
    """ⓐ: the ACTIVE switch reached the provider (the campaign is live there) but the call failed after it (a timeout): the start
    stops with its outcome unknown, the run stays «pending» with the campaign id. A cancel then used to end the cycle at once and
    clear the id — a live campaign nobody could stop or read. Now the campaign is paused first; only then the cycle ends."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    spy = sandbox.set_campaign_status  # _setup's spy (it records every status call)

    async def active_then_timeout(client, **kwargs):
        result = await spy(client, **kwargs)
        if kwargs["status"] == "ACTIVE":
            raise TimeoutError("the provider switched it on, the answer never came back")
        return result

    monkeypatch.setattr(sandbox, "set_campaign_status", active_then_timeout)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        stuck = await _run(Session, gate_id)
        assert stuck.status == "pending" and stuck.campaign_id and ("ACTIVE", stuck.campaign_id) in calls
        monkeypatch.setattr(sandbox, "set_campaign_status", spy)
        assert await _cancel(Session, org_id, gate_id, owner_id) == {"state": "cancelling"}
        assert (await _run(Session, gate_id)).campaign_id == stuck.campaign_id  # kept: it may be spending
        await _tick(Session)
        assert calls[-1] == ("PAUSED", stuck.campaign_id)
        cleared = await _run(Session, gate_id)
        assert (cleared.campaign_id, cleared.cancel_requested_at) == (None, None)
        assert [c.campaign_id for c in await _cycles(Session, gate_id)] == [stuck.campaign_id]
    finally:
        await engine.dispose()


async def test_a_start_stopped_for_a_person_is_voided_by_the_cancel(monkeypatch):
    """ⓑ: a start held «blocked» (stopped for a person: a connection-classified provider error · an org publish pause) counted
    as out, so the cancel waited on it forever («취소 중» with nothing to press). The gate is voided, so it could never switch
    anything on — the cancel voids it and ends. (The state is set directly: how a start gets there is 4476/3953's.)"""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        start = await _start_command(Session, org_id, gate_id, owner_id)
        start_id = getattr(start, "id", start)
        async with Session() as s:
            await s.execute(update(PublicationCommand).where(PublicationCommand.id == start_id).values(
                status="blocked", failure_kind="connection",
            ))
            await s.commit()
        assert await _cancel(Session, org_id, gate_id, owner_id) == {"state": "cancelled"}
        async with Session() as s:
            row = await s.get(PublicationCommand, start_id)
        assert (row.status, row.reason_code) == ("voided", "ADS_BOOST_CANCELLED")
    finally:
        await engine.dispose()


async def test_a_capture_counts_toward_the_cycle_it_was_taken_in(monkeypatch):
    """ⓒ: the cycle's total filtered captures by due_at ≥ cycle start, so a capture scheduled in cycle 1 but taken after cycle 2
    began (it reads the new campaign) fell out of cycle 2's total — and its cap. Captures now carry the cycle they were taken in:
    cycle 1's capture stays cycle 1's (the ledger keeps both), the late one counts for cycle 2."""
    import uuid as _uuid
    from datetime import timedelta

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import get_ads_boost_spend_summary, refresh_ads_boost_spend_now

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)  # cycle 1: 12,345
        gate = await _gate(Session, gate_id)
        async with Session() as s:  # scheduled in cycle 1 (due before cycle 2), taken later
            s.add(InsightSnapshot(
                id=_uuid.uuid4(), org_id=org_id, work_item_id=gate.work_item_id, publication_id=_uuid.UUID(gate.scope_key),
                publication_kind="channel_publication", channel="ads_sandbox",
                due_at=datetime.now(timezone.utc) - timedelta(minutes=1), status="pending",
            ))
            await s.commit()
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        await _new_seal_start(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        from tests.test_4466_money_stops_off_approved_realdb import _spend_tick

        await _spend_tick(Session)  # the late capture is taken now, in cycle 2
        from sqlalchemy import select

        async with Session() as s:
            summary = await get_ads_boost_spend_summary(s, org_id=org_id, gate_id=gate_id)
            taken = (await s.execute(
                select(InsightSnapshot.ads_boost_cycle, InsightSnapshot.due_at).where(
                    InsightSnapshot.publication_id == _uuid.UUID(gate.scope_key), InsightSnapshot.status == "captured",
                ).order_by(InsightSnapshot.captured_at)
            )).all()
        run = await _run(Session, gate_id)
        # cycle 1's own capture stays cycle 1's; two captures due in cycle 1 (the planted one · the one 4466's hook queued when
        # the cancel voided the gate) were taken in cycle 2 and count there — by the old due_at filter they were 0
        assert [c for c, _ in taken] == [1, 2, 2]
        assert all(due < run.cycle_started_at for _, due in taken[1:])
        assert summary["captured_spend_minor"] == 2 * 12_345
        [cycle1] = await _cycles(Session, gate_id)
        assert cycle1.spend_minor == 12_345
    finally:
        await engine.dispose()


async def test_an_agent_does_not_read_a_past_cycles_campaign_id(monkeypatch):
    """A past cycle's campaign id follows the current one's rule (people only)."""
    from app.main import app
    from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    _provider(monkeypatch)

    async def spend_as(user_id, *, agent=False):
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id, agent=agent)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
            assert r.status_code == 200, r.text
            return r.json()
        finally:
            app.dependency_overrides.clear()

    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        async with Session() as s:
            agent_id = await _seed_agent(s, org_id, project_id)
        assert (await spend_as(owner_id))["previous_cycles"][0]["campaign_id"]
        [seen] = (await spend_as(agent_id, agent=True))["previous_cycles"]
        assert seen["campaign_id"] is None and seen["spend_minor"] is not None
    finally:
        await engine.dispose()


async def test_a_new_cycle_is_not_started_until_its_own_start_and_shows_no_old_pause(monkeypatch):
    """«Started» and the card's latest pause read the current cycle: after the cancel and a new approval (no new start yet) a
    pause is refused as not started (cycle 1's start is not this cycle's), and /spend shows no pause (cycle 1's completed one is
    not the new campaign's)."""
    import pytest as _pytest

    from app.services.ads_boost_execution import AdsBoostNotStartedError, request_ads_boost_pause
    from app.services.ads_spend_snapshots import get_ads_boost_spend_summary

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        await _cancel(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=250_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        async with Session() as s:
            assert (await get_ads_boost_spend_summary(s, org_id=org_id, gate_id=gate_id))["pause_command"] is None
            with _pytest.raises(AdsBoostNotStartedError):
                await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
    finally:
        await engine.dispose()


async def test_a_pause_for_a_cancel_that_fails_is_not_asked_again_and_again(monkeypatch):
    """ⓐ's follow-up pause is asked once per cycle: if it fails at the provider the cancel stays «취소 중» (honest — the campaign
    is not known to be off) and the worker does not queue a new pause after every command (a loop)."""
    import app.services.ads_sandbox_campaign as sandbox
    from tests.test_4466_money_stops_off_approved_realdb import _pauses

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    spy = sandbox.set_campaign_status

    async def active_then_timeout(client, **kwargs):
        result = await spy(client, **kwargs)
        if kwargs["status"] == "ACTIVE":
            raise TimeoutError("switched on, no answer")
        return result

    async def pause_fails(client, **kwargs):
        if kwargs["status"] == "PAUSED":  # a terminal refusal (unmapped → needs_check · dead_letter): nothing is out any more
            from app.services.meta_ads_campaign import MetaAdsCampaignError

            raise MetaAdsCampaignError("META_ADS_TEST_PAUSE_REFUSED", "the provider refused the pause")
        return await spy(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", active_then_timeout)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        monkeypatch.setattr(sandbox, "set_campaign_status", pause_fails)
        await _cancel(Session, org_id, gate_id, owner_id)
        for _ in range(3):
            await _tick(Session)
        pauses = await _pauses(Session, gate_id)
        assert [p.status for p in pauses] == ["dead_letter"]  # asked once, not again after every command
        run = await _run(Session, gate_id)
        assert run.cancel_requested_at is not None and run.campaign_id  # still «취소 중»: the ids stay (not known to be off)
    finally:
        await engine.dispose()
