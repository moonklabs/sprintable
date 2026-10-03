"""story #4517 (PO 02:52Z · AC0 02:51Z) — the window between the worker's cap check and the provider's ACTIVE switch.

The worker read `cap_reached_at` once, at the top of a start/resume, from a run loaded without a lock; the provider calls hold no
transaction (4404). A capture that reached the cap after that check was not seen, and the campaign was switched on past the
approved budget. And the capture judged the run from a copy loaded before its own spend call: «paused» there, it recorded the cap
and stopped — no pause, no follow-up — while a resume switched the campaign on; only the next daily capture (up to a day) paused it.
Now (a) the worker reads the cap again right before ACTIVE (beside the seal's recheck) and (b) the capture reads the run's status
fresh, and the capture that reaches the cap on a paused run leaves one follow-up an hour later (a resume already out is paused
then; on a still-paused run that follow-up ends it — no chain). The provider is the sandbox fake.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3806_ads_boost_gate import _approve_gate
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse
from tests.test_4404_publish_worker_no_open_tx_realdb import _command, _run, _start_command, _tick
from tests.test_4460_cancel_this_boost_realdb import _request_again
from tests.test_4486_no_resume_past_cap_realdb import _setup_small

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


async def _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id):
    """Started (cap not reached — no capture has run yet), then paused by a person."""
    from app.services.ads_boost_execution import request_ads_boost_pause

    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    async with Session() as s:
        await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
    await _tick(Session)
    run = await _run(Session, gate_id)
    assert run.status == "paused" and run.cap_reached_at is None
    return run.campaign_id


async def _capture_now(Session, gate_id, now):
    """A paid capture due now, processed — the sandbox reports 12,345 against the 10,000 budget (late-reported spend)."""
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import _schedule_capture, process_due_ads_spend_snapshots

    async with Session() as s:
        await _schedule_capture(s, gate=await s.get(Gate, gate_id), due_at=now)
    async with Session() as s:
        return await process_due_ads_spend_snapshots(s, now=now)


async def _pending_captures(Session, gate_id):
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import paid_snapshots_only

    async with Session() as s:
        gate = await s.get(Gate, gate_id)
        return sorted((await s.execute(paid_snapshots_only(select(InsightSnapshot.due_at).where(
            InsightSnapshot.publication_id == gate.scope_key, InsightSnapshot.status == "pending",
        )))).scalars().all())


def _during_active(monkeypatch, hook):
    """Runs `hook` inside the provider's ACTIVE call (the worker holds no transaction then), once."""
    import app.services.ads_sandbox_campaign as sandbox

    inner = sandbox.set_campaign_status
    armed = {"on": True}

    async def wrapped(client, **kwargs):
        if kwargs["status"] == "ACTIVE" and armed["on"]:
            armed["on"] = False
            await hook()
        return await inner(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", wrapped)


def _cap_lands_before_the_call(monkeypatch, Session, gate_id):
    """The cap is recorded after the worker's first check, right before its provider call (a capture committing then)."""
    import app.services.ads_boost_execution as execution
    from sqlalchemy import update

    from app.models.ads_boost_run import AdsBoostRun

    original = execution._refuse_if_seal_replaced

    async def capture_lands_then_check(db, command, gid):
        async with Session() as s:
            await s.execute(update(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id).values(cap_reached_at=datetime.now(timezone.utc)))
            await s.commit()
        return await original(db, command, gid)

    monkeypatch.setattr(execution, "_refuse_if_seal_replaced", capture_lands_then_check)


async def test_a_capture_reaching_the_cap_during_a_resume_leaves_a_follow_up_that_pauses_it_within_the_hour(monkeypatch):
    """(b) The race: a person's paused boost, a late-reported spend capture reaching the cap while a resume's ACTIVE call is out.
    The capture sees «paused» (the worker commits «running» after the call). Before: the cap recorded, nothing else — the running
    boost spent past its budget until the next daily capture. Now a follow-up within the hour pauses it."""
    from app.services.ads_boost_execution import request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        campaign = await _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id)
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        now = datetime.now(timezone.utc)

        async def capture():
            counts = await _capture_now(Session, gate_id, now)
            assert counts["capped"] == 1, counts

        _during_active(monkeypatch, capture)
        await _tick(Session)
        run = await _run(Session, gate_id)
        assert run.status == "running" and run.cap_reached_at is not None  # the race happened: on, past the cap
        due = await _pending_captures(Session, gate_id)
        assert due and due[0] <= now + timedelta(hours=1, minutes=1), due  # before: the next one was the daily capture

        later = due[0] + timedelta(seconds=30)
        async with Session() as s:
            from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots

            await process_due_ads_spend_snapshots(s, now=later)
        await _tick(Session)
        assert calls[-1] == ("PAUSED", campaign)
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_the_cap_on_a_still_paused_boost_leaves_one_follow_up_and_no_chain(monkeypatch):
    """(b) Without a resume: the cap reached on a paused boost leaves one follow-up; that follow-up finds it still paused and ends
    there — no pause request, no further capture (the hour is not a new chain)."""
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id)
        before = await _pending_captures(Session, gate_id)
        now = datetime.now(timezone.utc)
        assert (await _capture_now(Session, gate_id, now))["capped"] == 1
        follow_up = [d for d in await _pending_captures(Session, gate_id) if d not in before]
        assert len(follow_up) == 1 and follow_up[0] <= now + timedelta(hours=1, minutes=1), follow_up
        async with Session() as s:
            await process_due_ads_spend_snapshots(s, now=follow_up[0] + timedelta(seconds=30))
        assert [d for d in await _pending_captures(Session, gate_id) if d not in before] == []
        async with Session() as s:
            pauses = (await s.execute(select(PublicationCommand.id).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
            ))).scalars().all()
        assert len(pauses) == 1  # the person's only
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_resume_whose_cap_lands_before_its_provider_call_is_refused(monkeypatch):
    """(a) The cap recorded after the worker's first check, before ACTIVE: refused with ADS_BOOST_CAP_REACHED, nothing switched on.
    Before: the resume passed on the first check's stale value and switched the campaign on."""
    from app.services.ads_boost_execution import request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        await _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id)
        async with Session() as s:
            resume = await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        _cap_lands_before_the_call(monkeypatch, Session, gate_id)
        actives = len([c for c in calls if c[0] == "ACTIVE"])
        await _tick(Session)
        done = await _command(Session, resume.id)
        assert (done.status, done.reason_code) == ("blocked_unapproved", "ADS_BOOST_CAP_REACHED")
        assert len([c for c in calls if c[0] == "ACTIVE"]) == actives
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_re_approved_start_whose_cap_lands_before_its_provider_call_is_refused(monkeypatch):
    """(a) The start branch (PO 04:01Z in 4486): the same post requested again without a cancel and re-approved, its start reusing
    the paused campaign — the cap landing before its ACTIVE: refused the same way, the campaign stays off."""
    from app.services.ads_boost_execution import request_ads_boost_start

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        campaign = await _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id)
        r = await _request_again(Session, org_id, owner_id, gate_id, budget_minor=10_000)
        assert r.status_code in (200, 201), r.text
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
        async with Session() as s:
            start = await request_ads_boost_start(
                s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="scheduler",
            )
        _cap_lands_before_the_call(monkeypatch, Session, gate_id)
        await _tick(Session)
        done = await _command(Session, start.id)
        assert (done.status, done.reason_code) == ("blocked_unapproved", "ADS_BOOST_CAP_REACHED")
        assert ("ACTIVE", campaign) not in calls[calls.index(("PAUSED", campaign)):]
        assert (await _run(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


async def test_a_resume_that_lands_during_the_captures_spend_call_is_paused_at_once(monkeypatch):
    """(b) The capture loaded the run (paused) before its spend call; the resume ran to the end during that call (running). The
    capture reaching the cap reads the status fresh → running → the scheduler's pause now, not an hour later."""
    import app.services.ads_sandbox_campaign as sandbox
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE, request_ads_boost_resume

    engine, Session, org_id, owner_id, gate_id, calls = await _setup_small(monkeypatch)
    try:
        campaign = await _running_then_paused_by_a_person(Session, org_id, owner_id, gate_id)
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        real_spend = sandbox.get_campaign_spend_minor
        armed = {"on": True}

        async def spend_while_the_resume_runs(client, **kwargs):
            if armed["on"]:
                armed["on"] = False
                await _tick(Session)  # the resume: ACTIVE · «running» committed
                assert (await _run(Session, gate_id)).status == "running"
            return await real_spend(client, **kwargs)

        monkeypatch.setattr(sandbox, "get_campaign_spend_minor", spend_while_the_resume_runs)
        assert (await _capture_now(Session, gate_id, datetime.now(timezone.utc)))["capped"] == 1
        async with Session() as s:
            scheduler_pauses = (await s.execute(select(PublicationCommand.id).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
                PublicationCommand.initiated_by == "scheduler",
            ))).scalars().all()
        assert len(scheduler_pauses) == 1  # before: none (the stale «paused»)
        await _tick(Session)
        assert calls[-1] == ("PAUSED", campaign)
    finally:
        await engine.dispose()
