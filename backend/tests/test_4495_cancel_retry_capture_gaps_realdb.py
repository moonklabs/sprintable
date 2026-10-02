"""story #4495 — four gaps in 4491's retry capture (Qadir 07:53Z), each pinned so that undoing the fix turns it red.

① The «three retries» limit: removing it used to stay green — the 4th failure's index overflow was swallowed by the isolated
   follow-up session (run_side_effect_in_own_session) and looked like «nothing scheduled». Now asserted with no failure logged.
② «scheduled» is said only while a paid capture really waits for the post (and within the three retries).
③ A cancel marks the run after the gate's flush; the capture hook now also fires on the run's cancel mark and reads the session's
   values, so a «pending» run with a campaign gets its capture at the cancel.
④ One waiting paid capture per post: the earliest is brought forward instead of a second row being added.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4404_publish_worker_no_open_tx_realdb import _run, _start_command, _tick
from tests.test_4142_recipe_async_video_publish_command_realdb import _configure_secrets  # noqa: F401 — autouse
from tests.test_4460_cancel_this_boost_realdb import _cancel, _setup
from tests.test_4491_cancel_pause_retry_capture_realdb import (
    _capture_at,
    _pause_fails,
    _pause_retry,
    _race_with_failing_pause,
)

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


async def _waiting_paid(Session, gate_id):
    """Every paid capture waiting for the post (no time window)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot

    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        return (await s.execute(select(InsightSnapshot.due_at).where(
            InsightSnapshot.publication_id == uuid.UUID(gate.scope_key), InsightSnapshot.status == "pending",
            InsightSnapshot.channel.in_(("meta_ads", "ads_sandbox")),
        ).order_by(InsightSnapshot.due_at))).scalars().all()


async def test_the_fourth_failure_schedules_nothing_and_nothing_is_swallowed(monkeypatch, caplog):
    """① After the third retry: no retry capture, and no follow-up failure was logged (an overflow swallowed by the isolated
    session would look the same from outside)."""
    engine, Session, org_id, _owner_id, gate_id, _calls, _left = await _race_with_failing_pause(monkeypatch, fails=99)
    try:
        with caplog.at_level(logging.WARNING, logger="app.services.isolated_side_effect"):
            for _ in range(4):
                soon = [d for d in await _waiting_paid(Session, gate_id) if d < datetime.now(timezone.utc) + timedelta(hours=2)]
                if not soon:
                    break
                await _capture_at(Session, soon[0] + timedelta(seconds=30))
                await _tick(Session)
        soon = [d for d in await _waiting_paid(Session, gate_id) if d < datetime.now(timezone.utc) + timedelta(hours=2)]
        assert soon == []
        assert [r for r in caplog.records if "부수 작업 실패" in r.getMessage()] == []
        assert await _pause_retry(Session, org_id, gate_id) == "exhausted"
    finally:
        await engine.dispose()


async def test_scheduled_is_said_only_when_a_capture_really_waits(monkeypatch):
    """② The retry capture could not be written (it raised — swallowed by the isolated session): the card must not promise a
    retry — «exhausted», not «scheduled», although only two pauses failed (the old rule counted failures)."""
    import app.services.ads_boost_gate_exit as gate_exit

    real = gate_exit._schedule_capture_now

    def boom(session, gate, *, due_at=None):
        if due_at is not None:  # only the retry (the 4466 capture-now keeps working)
            raise RuntimeError("the capture row could not be written")
        return real(session, gate, due_at=due_at)

    monkeypatch.setattr(gate_exit, "_schedule_capture_now", boom)
    engine, Session, org_id, _owner_id, gate_id, _calls, _left = await _race_with_failing_pause(monkeypatch, fails=99)
    try:
        # the capture the cancel itself queued (③) is a real retry coming: «scheduled» is true there
        soon = [d for d in await _waiting_paid(Session, gate_id) if d < datetime.now(timezone.utc) + timedelta(hours=2)]
        assert len(soon) == 1 and await _pause_retry(Session, org_id, gate_id) == "scheduled"
        await _capture_at(Session, soon[0] + timedelta(seconds=30))  # its pause fails too; the retry row cannot be written
        await _tick(Session)
        soon = [d for d in await _waiting_paid(Session, gate_id) if d < datetime.now(timezone.utc) + timedelta(hours=2)]
        assert soon == []
        assert await _pause_retry(Session, org_id, gate_id) == "exhausted"  # two failed pauses, but nothing really waits
    finally:
        await engine.dispose()


async def test_a_cancel_of_a_pending_run_with_a_campaign_gets_its_capture_at_once(monkeypatch):
    """③ The ACTIVE answer was lost (run «pending» with the campaign); the cancel voids the gate (flushed first) and marks the run
    (after): a paid capture is due now."""
    import app.services.ads_sandbox_campaign as sandbox

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    spy = sandbox.set_campaign_status

    async def active_then_lost(client, **kwargs):
        result = await spy(client, **kwargs)
        if kwargs["status"] == "ACTIVE":
            raise TimeoutError("switched on, no answer")
        return result

    monkeypatch.setattr(sandbox, "set_campaign_status", active_then_lost)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        assert (await _run(Session, gate_id)).status == "pending"
        _pause_fails(monkeypatch, times=0)
        await _cancel(Session, org_id, gate_id, owner_id)
        now = datetime.now(timezone.utc)
        assert [d for d in await _waiting_paid(Session, gate_id) if d <= now + timedelta(seconds=5)] != []
    finally:
        await engine.dispose()


async def test_one_waiting_capture_per_post_brought_forward(monkeypatch):
    """④ A running boost has its daily capture waiting (start + 1 day); its gate leaves «approved» (the same post requested
    again): the waiting capture is brought forward to now — still one row, not two."""
    from tests.test_4466_money_stops_off_approved_realdb import _reopen

    engine, Session, org_id, owner_id, gate_id, _calls = await _setup(monkeypatch)
    try:
        await _start_command(Session, org_id, gate_id, owner_id)
        await _tick(Session)
        [daily] = await _waiting_paid(Session, gate_id)
        assert daily - datetime.now(timezone.utc) > timedelta(hours=23)
        await _reopen(Session, org_id, owner_id, gate_id)
        waiting = await _waiting_paid(Session, gate_id)
        assert len(waiting) == 1 and waiting[0] <= datetime.now(timezone.utc) + timedelta(seconds=5)
    finally:
        await engine.dispose()
