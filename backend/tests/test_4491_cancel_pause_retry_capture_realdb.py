"""story #4491 — a cancel's pause that failed at the provider (dead_letter) is tried again without a person.

Qadir 05:25Z · PO 06:26Z: under a cancel, nothing retried a pause that ended dead_letter (a dead_letter has no next attempt · the
cancel's hook asks once · 4466's capture-now needs the run live when the gate is voided, and in the race it was still pending) —
the campaign ran until the next daily capture, or never past the boost's end. Now that failure schedules a spend capture 5 · 20 ·
80 minutes on (by how many of the cycle's pauses failed); the capture sees the voided gate and the scheduler pauses again (4417
makes a new pause after a failed one). After the third: no more here (daily captures · the card points at Ads Manager). /spend
says which («scheduled» · «exhausted»).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4404_publish_worker_no_open_tx_realdb import _run, _start_command, _tick
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse
from tests.test_4460_cancel_this_boost_realdb import _cancel_during_active, _cycles, _setup

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


def _pause_fails(monkeypatch, *, times: int):
    """The provider refuses the next `times` pauses terminally (unmapped → needs_check · dead_letter), then accepts."""
    import app.services.ads_sandbox_campaign as sandbox
    from app.services.meta_ads_campaign import MetaAdsCampaignError

    inner = sandbox.set_campaign_status
    left = {"n": times}

    async def maybe_refuse(client, **kwargs):
        if kwargs["status"] == "PAUSED" and left["n"] > 0:
            left["n"] -= 1
            raise MetaAdsCampaignError("META_ADS_TEST_PAUSE_REFUSED", "the provider refused the pause")
        return await inner(client, **kwargs)

    monkeypatch.setattr(sandbox, "set_campaign_status", maybe_refuse)
    return left


async def _pending_captures(Session, gate_id):
    """The retry captures: pending, due within two hours (the boost's regular capture a day after the start stays out)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot

    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        return (await s.execute(select(InsightSnapshot.due_at).where(
            InsightSnapshot.publication_id == uuid.UUID(gate.scope_key), InsightSnapshot.status == "pending",
            InsightSnapshot.due_at < datetime.now(timezone.utc) + timedelta(hours=2),
        ).order_by(InsightSnapshot.due_at))).scalars().all()


async def _capture_at(Session, at):
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots

    async with Session() as s:
        return await process_due_ads_spend_snapshots(s, now=at)


async def _pause_retry(Session, org_id, gate_id):
    from app.services.ads_spend_snapshots import get_ads_boost_spend_summary

    async with Session() as s:
        return (await get_ads_boost_spend_summary(s, org_id=org_id, gate_id=gate_id))["pause_retry"]


async def _race_with_failing_pause(monkeypatch, *, fails: int):
    """Qadir 04:29Z's race (the cancel commits right before the start's ACTIVE) whose follow-up pause the provider refuses."""
    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    _cancel_during_active(monkeypatch, Session, org_id, gate_id, owner_id)
    left = _pause_fails(monkeypatch, times=fails)
    await _start_command(Session, org_id, gate_id, owner_id)
    await _tick(Session)
    await _tick(Session)
    return engine, Session, org_id, owner_id, gate_id, calls, left


async def test_a_failed_cancel_pause_is_tried_again_by_a_capture_and_the_cancel_ends(monkeypatch):
    engine, Session, org_id, _owner_id, gate_id, calls, _left = await _race_with_failing_pause(monkeypatch, fails=1)
    try:
        run = await _run(Session, gate_id)
        assert run.status == "running" and run.cancel_requested_at is not None  # the pause failed: still live
        due = await _pending_captures(Session, gate_id)
        start = datetime.now(timezone.utc)
        assert len(due) == 1 and timedelta(minutes=4) < due[0] - start <= timedelta(minutes=5)
        assert await _pause_retry(Session, org_id, gate_id) == "scheduled"
        await _capture_at(Session, start + timedelta(minutes=6))  # the scheduler's pause (4417: a new one after a failed one)
        await _tick(Session)
        assert calls[-1][0] == "PAUSED"
        cleared = await _run(Session, gate_id)
        assert (cleared.campaign_id, cleared.cancel_requested_at) == (None, None)
        [cycle] = await _cycles(Session, gate_id)
        assert cycle.end_reason == "cancelled"
    finally:
        await engine.dispose()


async def test_a_pause_that_keeps_failing_is_retried_three_times_then_left_to_a_person(monkeypatch):
    """5 · 20 · 80 minutes, then nothing more here (no loop) and /spend says «exhausted»."""
    from tests.test_4466_money_stops_off_approved_realdb import _pauses

    engine, Session, org_id, _owner_id, gate_id, _calls, _left = await _race_with_failing_pause(monkeypatch, fails=99)
    try:
        gaps = []
        for _ in range(3):
            due = await _pending_captures(Session, gate_id)
            assert len(due) == 1, due
            now = datetime.now(timezone.utc)
            gaps.append(round((due[0] - now).total_seconds() / 60))
            await _capture_at(Session, due[0] + timedelta(seconds=30))
            await _tick(Session)
        assert gaps == [5, 20, 80]
        assert await _pending_captures(Session, gate_id) == []  # the 4th failure schedules nothing
        assert [p.status for p in await _pauses(Session, gate_id)] == ["dead_letter"] * 4
        assert await _pause_retry(Session, org_id, gate_id) == "exhausted"
        assert (await _run(Session, gate_id)).cancel_requested_at is not None  # honest: still «취소 중»
    finally:
        await engine.dispose()


async def test_a_persons_failed_pause_without_a_cancel_schedules_nothing(monkeypatch):
    """Not the same defect: an approved boost within budget — a person retries (4417 · the card's failure block)."""
    from app.services.ads_boost_execution import request_ads_boost_pause

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    _pause_fails(monkeypatch, times=1)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        before = await _pending_captures(Session, gate_id)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        await _tick(Session)
        assert await _pending_captures(Session, gate_id) == before
        assert await _pause_retry(Session, org_id, gate_id) is None
    finally:
        await engine.dispose()


async def test_a_campaign_whose_active_answer_was_lost_is_also_retried_by_a_capture(monkeypatch):
    """PO 06:34Z — 4460's ⓐ: the ACTIVE switch went out and its answer was lost (run «pending» with the campaign — treated as on).
    Under a cancel its pause was refused → the same retry: a capture at +5 → the scheduler pauses it (a pending run counts as live
    here) → lands → the cancel ends. Not «exhausted» at once."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, calls = await _setup(monkeypatch)
    spy = sandbox.set_campaign_status

    async def active_then_lost(client, **kwargs):
        result = await spy(client, **kwargs)
        if kwargs["status"] == "ACTIVE":
            raise TimeoutError("the provider switched it on, the answer never came back")
        return result

    monkeypatch.setattr(sandbox, "set_campaign_status", active_then_lost)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        stuck = await _run(Session, gate_id)
        assert stuck.status == "pending" and stuck.campaign_id
        monkeypatch.setattr(sandbox, "set_campaign_status", spy)
        _pause_fails(monkeypatch, times=1)
        from tests.test_4460_cancel_this_boost_realdb import _cancel

        assert await _cancel(Session, org_id, gate_id, owner_id) == {"state": "cancelling"}
        await _tick(Session)  # the cancel's pause → refused → dead_letter
        assert (await _run(Session, gate_id)).status == "pending"
        assert await _pause_retry(Session, org_id, gate_id) == "scheduled"
        due = await _pending_captures(Session, gate_id)
        assert len(due) == 1
        await _capture_at(Session, due[0] + timedelta(seconds=30))
        await _tick(Session)
        assert calls[-1] == ("PAUSED", stuck.campaign_id)
        cleared = await _run(Session, gate_id)
        assert (cleared.campaign_id, cleared.cancel_requested_at) == (None, None)
    finally:
        await engine.dispose()


async def test_a_cancel_follow_up_that_raises_leaves_the_commands_result_and_the_next_item(monkeypatch):
    """PO 07:10Z — the cancel's follow-ups run after the command's result is committed, each in its own session. One that raises
    (here the retry capture) leaves the pause's dead_letter committed, never reaches the batch as an error (the batch session is
    not rolled back under it), and the next command of the same batch (another boost's start) is processed as usual. Before: the follow-ups ran in the batch session
    ahead of its commit, so the raise rolled the pause back to in_progress."""
    import app.services.ads_boost_cancel as cancel_mod
    from app.models.publication_command import PublicationCommand
    from tests.test_4404_publish_worker_no_open_tx_realdb import _command
    from tests.test_4460_cancel_this_boost_realdb import _cancel
    from tests.test_4466_money_stops_off_approved_realdb import _pauses

    engine_a, Session, org_a, owner_a, gate_a, _calls = await _setup(monkeypatch)
    engine_b, Session_b, org_b, owner_b, gate_b, _calls_b = await _setup(monkeypatch)
    _pause_fails(monkeypatch, times=1)

    async def boom(*args, **kwargs):
        raise RuntimeError("the retry capture failed")

    monkeypatch.setattr(cancel_mod, "schedule_capture_after_failed_cancel_pause", boom)
    try:
        await _start_command(Session, org_a, gate_a, owner_a)
        await _tick(Session)
        assert await _cancel(Session, org_a, gate_a, owner_a) == {"state": "cancelling"}  # A's pause queued (it will fail)
        start_b = await _start_command(Session_b, org_b, gate_b, owner_b)  # queued after A's pause: same batch, next item
        counts = await _tick(Session)
        assert counts.get("error", 0) == 0, counts  # a follow-up's failure is not the command's: nothing reaches the batch
        [pause_a] = await _pauses(Session, gate_a)
        assert pause_a.status == "dead_letter"  # the result stays although its follow-up raised
        start_b_id = getattr(start_b, "id", start_b)
        assert (await _command(Session_b, start_b_id)).status == "completed"
        assert (await _run(Session_b, gate_b)).status == "running"
        async with Session() as s:
            assert (await s.get(PublicationCommand, pause_a.id)).status == "dead_letter"
    finally:
        await engine_a.dispose()
        await engine_b.dispose()
