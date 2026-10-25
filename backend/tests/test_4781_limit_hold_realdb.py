"""story 4781 (AC1 · AC2 server layer · PO 10-25) — the account usage limit notice reaches the right person ONCE and «working again» is true.

10-25: a stuck session's Claude Code resubmitted its prompt by itself every ~30 minutes; the daemon reported «working» for a second, the server read «the limit is over» and
sent `agent.limit_lifted`, and the same limit error a second later brought `agent.limit_paused` again — ten false «다시 움직여요» in a day, none true. And the log never said WHOM a
notice was meant for, so «did it reach the owner» could not be answered. These tests drive the relay's report endpoints over a migrated PG (the 4685 harness):
- a lift is held `LIFT_HOLD_SEC`; a limit that comes back inside the hold cancels the line AND the new «stopped» notice (one stop · zero lifts for the 10-25 shape);
- a limit that stays gone is told once — by the next report once the hold ran out, or by the sweep when no report comes — and never twice (atomic claim, two sweeps at once);
- an ended session waits for nothing; the boundary of the hold is pinned on both sides;
- the log says whom (member id prefix, no names), how many were sent, and why a notice did not go.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    OWNER_TM,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4685_limit_notice_realdb import LIFTED, LOOKS, STOOD, _notices, _report

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


async def _cleared_at(device) -> datetime | None:
    rows = await _sql(fetch="SELECT limit_cleared_at FROM desktop_sessions WHERE setup_id = :s", params={"s": device["setup_id"]})
    return rows[0][0]


async def _age_the_wait(device, seconds: float) -> None:
    await _sql("UPDATE desktop_sessions SET limit_cleared_at = now() - make_interval(secs => :s) WHERE setup_id = :x AND limit_cleared_at IS NOT NULL",
               params={"s": seconds, "x": device["setup_id"]})


async def _sweep() -> int:
    from app.core.database import async_session_factory
    from app.services.desktop_limit_notice import sweep_due_lifts

    async with async_session_factory() as db:
        n = await sweep_due_lifts(db)
        await db.commit()
        return n


async def _release_stood_window() -> None:
    from app.services.desktop_limit_notice import _release_window

    await _release_window(ORG, OWNER)  # the 5-minute window of the stopped notice is not what is under test: it is let go, so only the hold can hold


async def test_01_the_10_25_shape_one_stop_and_no_lift_when_the_limit_comes_back_inside_the_hold(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac a")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        assert len(await _notices(STOOD)) == 1
        for seq in range(3, 33, 3):  # ten times: the CLI's own retry reads «working» for a second, then the same limit error
            await _report(c, device, a, "working", seq)
            assert await _cleared_at(device) is not None, "the lift waits"
            await _release_stood_window()  # (the old code told a new stop every time the 5-minute window had run out)
            await _report(c, device, a, "waiting_input", seq + 1, limit=LOOKS)
            assert await _cleared_at(device) is None, "the limit came back: nothing waits"
        assert len(await _notices(STOOD)) == 1, "one stop for the whole episode"
        assert await _notices(LIFTED) == [], "and not one lift: it never lifted"


async def test_02_a_limit_that_stays_gone_is_told_once_by_the_next_report_after_the_hold(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac b")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)
        assert await _notices(LIFTED) == [] and await _cleared_at(device) is not None
        await _report(c, device, a, "idle", 4)  # a report inside the hold tells nothing
        assert await _notices(LIFTED) == []
        await _age_the_wait(device, 200)
        await _report(c, device, a, "working", 5)  # the hold ran out: this report tells it
        assert len(await _notices(LIFTED)) == 1 and await _cleared_at(device) is None
        await _report(c, device, a, "idle", 6)
        await _report(c, device, a, "working", 7)
        assert len(await _notices(LIFTED)) == 1, "once"


async def test_03_the_hold_is_pinned_on_both_sides(world):
    from app.services.desktop_limit_notice import LIFT_HOLD_SEC

    assert 60 <= LIFT_HOLD_SEC <= 90, "the story asked for 60–90 seconds"
    async with _client() as c:
        device = await _device(c, "d4781 mac c")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)
        await _age_the_wait(device, LIFT_HOLD_SEC - 10)
        await _report(c, device, a, "idle", 4)
        assert await _notices(LIFTED) == [], "ten seconds short of the hold: not yet"
        await _age_the_wait(device, LIFT_HOLD_SEC + 10)
        await _report(c, device, a, "working", 5)
        assert len(await _notices(LIFTED)) == 1, "ten seconds past: told"


async def test_04_the_sweep_tells_a_lift_when_no_report_comes_and_never_twice(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac d")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)
        assert await _sweep() == 0 and await _notices(LIFTED) == [], "inside the hold the sweep tells nothing"
        await _age_the_wait(device, 200)
        told = await asyncio.gather(_sweep(), _sweep())  # two instances at once
        assert sorted(told) == [0, 1], told
        assert len(await _notices(LIFTED)) == 1 and await _cleared_at(device) is None
        assert await _sweep() == 0


async def test_05_a_session_that_ends_waits_for_nothing(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac e")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)
        assert await _cleared_at(device) is not None
        await _report(c, device, a, "stopped", 4)
        assert await _cleared_at(device) is None
        await _age_the_wait(device, 200)
        assert await _sweep() == 0 and await _notices(LIFTED) == [], "an ended session is not «working again»"
        # a new session under the same key that stands is a NEW stop (nothing was waiting to cancel it)
        await _release_stood_window()
        await _report(c, device, a, "working", 5)
        await _report(c, device, a, "waiting_input", 6, limit=LOOKS)
        assert len(await _notices(STOOD)) == 2


async def test_05b_a_session_that_ends_while_its_lift_waits_clears_the_notice_outstanding_for_it(world):
    """codex 01a174dd: limited → working (the lift waits) → stopped. The «stopped» notice's promise must not stay open: a later session of the same person that stands and returns
    would be told a «working again» that was never this one's. (The same as a limited session that ends: the promise is cleared without a line.)"""
    async with _client() as c:
        device = await _device(c, "d4781 mac e2")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)  # the lift waits
        await _report(c, device, a, "stopped", 4)  # … and the session ends
        assert await _notices(LIFTED) == []
        # a new session under another key stands inside the window (folded into the first notice) and comes back
        await _report(c, device, a, "working", 5, key="s-2")
        await _report(c, device, a, "waiting_input", 6, key="s-2", limit=LOOKS)
        await _report(c, device, a, "working", 7, key="s-2")
        await _age_the_wait(device, 200)
        assert await _sweep() in (0, 1)
        assert await _notices(LIFTED) == [], "no promise was left open by the ended session"


async def test_05c_a_session_that_ends_does_not_take_the_promise_while_another_of_the_person_still_waits_for_its_lift(world):
    """codex 01a174f2: two sessions come back and both lifts wait; one of them ends first. It must not consume the promise (the other has not been confirmed back yet), or the other's
    lift finds none and «working again» is never told."""
    async with _client() as c:
        device = await _device(c, "d4781 mac e3")
        a = device["agents"][0]["member_id"]
        for seq, key in ((1, "s-1"), (2, "s-2")):
            await _report(c, device, a, "working", seq, key=key)
        await _report(c, device, a, "waiting_input", 3, key="s-1", limit=LOOKS)
        await _report(c, device, a, "waiting_input", 4, key="s-2", limit=LOOKS)  # (folded into the first notice)
        await _report(c, device, a, "working", 5, key="s-1")
        await _report(c, device, a, "working", 6, key="s-2")  # both lifts wait
        await _report(c, device, a, "stopped", 7, key="s-1")  # one ends
        assert await _notices(LIFTED) == []
        await _age_the_wait(device, 200)
        assert await _sweep() == 1
        assert len(await _notices(LIFTED)) == 1, "the other session's lift is told once, with the promise still there"


async def test_05d_a_stop_counts_the_agents_standing_now_not_the_ones_whose_lift_waits(world):
    async with _client() as c:
        d1, d2 = await _device(c, "d4781 mac e4"), await _device(c, "d4781 mac e5")
        a1, a2 = d1["agents"][0]["member_id"], d2["agents"][0]["member_id"]
        await _report(c, d1, a1, "working", 1)
        await _report(c, d1, a1, "waiting_input", 2, limit=LOOKS)
        await _report(c, d1, a1, "working", 3)  # its lift waits: it is not at the limit any more
        await _release_stood_window()
        await _report(c, d2, a2, "working", 1)
        await _report(c, d2, a2, "waiting_input", 2, limit=LOOKS)
        first, second = await _notices(STOOD)
        assert second["title"] == f"{second['agent_name']} · 한도로 쉬는 중", "one agent stands now: the single-agent title, not «and N more»"


async def test_05e_a_session_that_came_back_is_told_when_the_one_it_waited_for_ends_instead_of_returning(world):
    """Kadir's lens on 5235: A and B both stood and both wait for their lifts; A's hold ends first (B still waits → A's line is held back) and then B ENDS. A is working — the
    outstanding notice must be told, not cleared silently."""
    async with _client() as c:
        device = await _device(c, "d4781 mac e6")
        a = device["agents"][0]["member_id"]
        for seq, key in ((1, "s-1"), (2, "s-2")):
            await _report(c, device, a, "working", seq, key=key)
        await _report(c, device, a, "waiting_input", 3, key="s-1", limit=LOOKS)
        await _report(c, device, a, "waiting_input", 4, key="s-2", limit=LOOKS)
        await _report(c, device, a, "working", 5, key="s-1")
        await _report(c, device, a, "working", 6, key="s-2")                         # both lifts wait
        await _sql("UPDATE desktop_sessions SET limit_cleared_at = now() - interval '200 seconds' WHERE setup_id = :x AND session_key = 's-1'", params={"x": device["setup_id"]})
        await _report(c, device, a, "idle", 7, key="s-1")                               # A's hold ran out: its own report claims it — B still waits, so nothing is told
        assert await _notices(LIFTED) == []
        await _report(c, device, a, "stopped", 8, key="s-2")                            # B ends instead of returning
        assert len(await _notices(LIFTED)) == 1, "A is working: «working again» is told, not cleared silently"


async def test_05f_a_session_that_ends_alone_still_clears_the_notice_without_a_line(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac e7")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1, key="s-1")
        await _report(c, device, a, "waiting_input", 2, key="s-1", limit=LOOKS)
        await _report(c, device, a, "stopped", 3, key="s-1")
        assert await _notices(LIFTED) == [], "nobody had come back: an ended session is not «working again»"


async def test_05g_a_batch_of_waiting_lifts_is_swept_fifty_at_a_time_and_told_once(world):
    from sqlalchemy import text  # noqa: F401

    async with _client() as c:
        device = await _device(c, "d4781 mac e8")
        a = device["agents"][0]["member_id"]
        seq = 0
        for i in range(60):
            for state, limit in (("working", None), ("waiting_input", LOOKS), ("working", None)):
                seq += 1
                await _report(c, device, a, state, seq, key=f"b-{i}", limit=limit)
        await _age_the_wait(device, 200)
        assert (await _sweep(), await _sweep(), await _sweep()) == (50, 10, 0), "a batch is at most 50 rows; the rest next tick"
        assert len(await _notices(LIFTED)) == 1, "sixty sessions of one person: ONE line"


async def test_06_a_real_lift_after_a_flap_is_still_told(world):
    async with _client() as c:
        device = await _device(c, "d4781 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)  # a flap …
        await _report(c, device, a, "waiting_input", 4, limit=LOOKS)
        assert await _notices(LIFTED) == []
        await _report(c, device, a, "working", 5)  # … and then it really lifts
        await _age_the_wait(device, 200)
        assert await _sweep() == 1
        assert len(await _notices(STOOD)) == 1 and len(await _notices(LIFTED)) == 1


async def test_07_the_log_says_whom_how_many_and_why_not_without_a_name(world, caplog):
    caplog.set_level(logging.INFO, logger="app.services.desktop_limit_notice")
    async with _client() as c:
        device = await _device(c, "d4781 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        who = str(OWNER_TM)[:8]
        text = "\n".join(r.getMessage() for r in caplog.records)
        assert f"stood setup={device['setup_id']}" in text and f"to={who}" in text, text
        assert f"stood sent setup={device['setup_id']} to={who} sent=1" in text, text
        # the window folds a second stop for the same person — and says so (10-25: a notice that did not go left no trace)
        d2 = await _device(c, "d4781 mac h")
        a2 = d2["agents"][0]["member_id"]
        caplog.clear()
        await _report(c, d2, a2, "working", 1)
        await _report(c, d2, a2, "waiting_input", 2, limit=LOOKS)
        assert any("stood not sent (a notice went to this person within the window)" in r.getMessage() and f"to={who}" in r.getMessage() for r in caplog.records)
        # the held lift and the told lift — the other computer's session comes back first (its line does not go: the first is still standing — and the log says so)
        await _report(c, d2, a2, "working", 3)
        await _age_the_wait(d2, 200)
        await _report(c, d2, a2, "idle", 4)
        assert any("lifted not sent (some still stand)" in r.getMessage() and f"to={who}" in r.getMessage() for r in caplog.records)
        caplog.clear()
        await _report(c, device, a, "working", 3)
        await _age_the_wait(device, 200)
        await _report(c, device, a, "idle", 4)
        text = "\n".join(r.getMessage() for r in caplog.records)
        assert "lift waits" in text and "lift told" in text and f"lifted sent setup={device['setup_id']} to={who} sent=1" in text, text
        # no names, no e-mail, no whole id
        assert str(OWNER_TM) not in text and "@" not in text


async def test_08_the_push_summary_names_each_person_by_prefix_with_their_own_counts(world, caplog):
    from unittest.mock import AsyncMock, patch

    from ee.services import expo_push as expo

    me, other, none = uuid.uuid4(), uuid.uuid4(), None
    devices = [
        {"expo_push_token": "ExponentPushToken[SECRET-1]", "id": uuid.uuid4(), "platform": "ios", "member_id": me},
        {"expo_push_token": "ExponentPushToken[SECRET-2]", "id": uuid.uuid4(), "platform": "android", "member_id": me},
        {"expo_push_token": "ExponentPushToken[SECRET-3]", "id": uuid.uuid4(), "platform": "android", "member_id": other},
        {"expo_push_token": "ExponentPushToken[SECRET-4]", "id": uuid.uuid4(), "platform": "ios", "member_id": none},
    ]
    tickets = [{"status": "ok", "id": "t1"}, {"status": "error", "details": {"error": "InvalidCredentials"}}, {"status": "ok", "id": "t3"}, {"status": "ok", "id": "t4"}]
    caplog.set_level(logging.INFO, logger="ee.services.expo_push")
    with patch("ee.services.expo_push._expo_send_chunk", new=AsyncMock(return_value=tickets)):
        await expo._send_expo_push_targets(devices, title="t", body="b", event_type="agent.limit_paused", org_id=uuid.uuid4())
    (line,) = [r for r in caplog.records if r.getMessage().startswith("expo push: recipients")]
    text = line.getMessage()
    assert f"{str(me)[:8]}(devices=2 ok=1 error=1)" in text and f"{str(other)[:8]}(devices=1 ok=1 error=0)" in text and "unknown(devices=1 ok=1 error=0)" in text, text
    assert "SECRET" not in text and str(me) not in text and "ExponentPushToken" not in text
    assert text.endswith("error_platforms=android:1") and line.structured["error_platforms"] == {"android": 1}, text  # (AC3: the failing device is an android one)
    assert line.structured["event"] == expo.EXPO_PUSH_RECIPIENTS_EVENT and line.structured["to"][str(me)[:8]] == {"devices": 2, "ok": 1, "error": 1}
    # a crowd is bounded, with a count of the rest
    many = {f"{i:08x}": {"devices": 1, "ok": 1, "error": 0} for i in range(30)}
    out = expo._recipients_text(many)
    assert out.count("(devices=") == expo._RECIPIENTS_LINE_MAX and out.endswith("+10")
    assert expo._member_prefix("not-an-id") == "unknown" and expo._member_prefix(None) == "unknown"


async def test_09_the_sweep_loop_tells_a_due_lift_by_itself_and_a_failed_tick_does_not_stop_it(world, monkeypatch):
    from app.services import desktop_limit_notice as dln

    monkeypatch.setattr(dln, "LIFT_SWEEP_SEC", 0.05)
    async with _client() as c:
        device = await _device(c, "d4781 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "waiting_input", 2, limit=LOOKS)
        await _report(c, device, a, "working", 3)
        await _age_the_wait(device, 200)
        calls = {"n": 0}
        real = dln.sweep_due_lifts

        async def flaky(db):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("one bad tick")
            return await real(db)

        monkeypatch.setattr(dln, "sweep_due_lifts", flaky)
        task = asyncio.create_task(dln.lift_sweep_loop())
        try:
            for _ in range(200):  # condition wait: the line arrives on the second tick
                if len(await _notices(LIFTED)) == 1:
                    break
                await asyncio.sleep(0.05)  # fixed-sleep-ok: polling the condition
            assert len(await _notices(LIFTED)) == 1 and calls["n"] >= 2
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


def test_10_the_sweep_is_started_with_the_app_and_stopped_with_it():
    import inspect

    from app import main

    src = inspect.getsource(main.lifespan)
    assert "lift_sweep_loop()" in src and "lift_sweep_task.cancel()" in src and "await lift_sweep_task" in src
    assert 'PYTEST_CURRENT_TEST' in src.split("lift_sweep_task = None")[1].split("lift_sweep_loop")[0], "like the other workers, not under pytest"


async def test_11_the_sweep_reads_through_a_partial_index_that_only_holds_waiting_rows(world):
    rows = await _sql(fetch="SELECT indexdef FROM pg_indexes WHERE tablename = 'desktop_sessions' AND indexname = 'ix_desktop_sessions_limit_cleared_at'")
    assert len(rows) == 1, "migration 0467 creates the partial index"
    assert "limit_cleared_at IS NOT NULL" in rows[0][0], rows[0][0]
