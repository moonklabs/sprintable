"""story 4863 (PO 11-09) — an agent on a person's computer was ended from OUTSIDE and nothing started it again: the people who hold that computer are told once.

11-08 23:17Z: six lane sessions were killed together, the app's two tries died too, the app itself was gone — and for 79 minutes nobody was told. The daemon (which outlives
the app) says it on the session's own `stopped` report (`restart_stopped`, an additive field): these tests drive the relay's state endpoint over a migrated PG (the 4424/4529/4685
harness) — the report is the only input, the notice the only output. Each claim has a test that goes red without it (mutants in the PR).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    ORG2,
    OWNER,
    OWNER_TM,
    _addresses,  # the autouse fixture that gives the exchange its MCP · API addresses: without it every `_device` is a 503 on a shell that has none set
    _client,
    _dispose_global_engine_after_test,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok

pytestmark = pytest.mark.anyio

TYPE = "agent.restart_stopped"


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    # the record of «already told» is the notification row itself: nothing of an earlier test (or an earlier run on this database) may stand in for it
    await _sql("DELETE FROM notifications WHERE type = 'agent.restart_stopped'", "DELETE FROM events WHERE payload->>'event_type' = 'agent.restart_stopped'")
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


AT0 = "2026-11-09T01:00:00+00:00"


async def _report(c, device, agent, state, seq, *, key="s-1", extra=None, expect=200, at=None):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": at or _now().isoformat(), **(extra or {})}
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _notices(member=OWNER_TM):
    rows = await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                             "AND payload->>'event_type' = :t ORDER BY created_at"), params={"m": member, "t": TYPE})
    return [r[0] for r in rows]


async def _cards(user_id) -> int:
    """how many restart notices (notification rows — the record of «told») this person holds"""
    rows = await _sql(fetch="SELECT count(*) FROM notifications WHERE type = 'agent.restart_stopped' AND user_id = :u", params={"u": user_id})
    return rows[0][0]


async def test_01_a_stopped_report_that_says_nobody_started_it_again_tells_the_person_once(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac a")
        agent = device["agents"][0]["member_id"]
        await _report(c, device, agent, "working", 1)
        await _report(c, device, agent, "stopped", 2)  # the end itself (the daemon says it at once)
        assert await _notices() == [], "an ended session alone is not this notice: the app may well start it again"
        await _report(c, device, agent, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함"
        assert n["body"] == "밖에서 꺼진 뒤 다시 띄우지 못했어요. 이 컴퓨터의 Sprintable 앱을 열어 확인해 주세요."
        # nothing of the computer in the words: no path, no user name, no key
        assert "/" not in n["body"] and "~" not in n["body"] and "sdt_" not in str(n)
        # the same session said again (a retry after a lost answer) is not told again
        await _report(c, device, agent, "stopped", 4, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1


async def test_02_the_field_is_for_a_stopped_report_only(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac b")
        agent = device["agents"][0]["member_id"]
        for seq, state in enumerate(["working", "idle", "error", "waiting_input"], start=1):
            await _report(c, device, agent, state, seq, extra={"restart_stopped": {"also": []}}, expect=422)
        assert await _notices() == []


async def test_03_the_others_named_are_counted_only_when_they_have_a_session_on_this_computer(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        other_computer = await _device(c, "d4863 mac c2")
        stranger = other_computer["agents"][0]["member_id"]  # same organization, another computer
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, b, "working", 2, key="s-b")
        await _report(c, other_computer, stranger, "working", 1, key="s-x")
        # the other agent of THIS computer is counted; another computer's agent, a made-up id and itself are dropped
        await _report(c, device, a, "stopped", 3, key="s-a", extra={"restart_stopped": {"also": [b, stranger, str(uuid.uuid4()), a]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} 외 1개 · 꺼진 뒤 다시 서지 못함"
        assert stranger not in str(n) and "외 2개" not in n["title"]


async def test_04_ids_that_are_not_on_this_computer_make_no_count_at_all(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac d")
        a = device["agents"][0]["member_id"]
        other_computer = await _device(c, "d4863 mac d2")
        stranger = other_computer["agents"][0]["member_id"]
        await _report(c, other_computer, stranger, "working", 1, key="s-x")
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": [stranger, str(uuid.uuid4())]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함", "no «외 N개» from ids this computer has no session for"


async def test_05_one_notice_per_person_per_window_for_agents_ended_together(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac e")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        await _report(c, device, a, "working", 1, key="s-a")
        await _report(c, device, b, "working", 2, key="s-b")
        await _report(c, device, a, "stopped", 3, key="s-a", extra={"restart_stopped": {"also": [b]}})
        await _report(c, device, b, "stopped", 4, key="s-b", extra={"restart_stopped": {"also": [a]}})  # inside the window: folded into the first
        assert len(await _notices()) == 1


async def test_06_a_failing_notice_never_fails_the_report(world, monkeypatch):
    async with _client() as c:
        device = await _device(c, "d4863 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)

        import app.services.notification_dispatch as nd

        async def boom(*_a, **_k):
            raise RuntimeError("the dispatcher is down")

        monkeypatch.setattr(nd, "dispatch_notification", boom)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)  # 200 — the record stands
        row = await _sql(fetch=f"SELECT state FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        assert row[0][0] == "stopped"
        # …and since nobody was told (nothing is recorded for a notice that failed), the same end said again IS told
        monkeypatch.undo()
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1


async def test_07_nobody_to_tell_is_not_a_failure(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _sql(f"UPDATE members SET is_active = false WHERE id = '{OWNER_TM}'")
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}})  # 200 — nobody told
        await _sql(f"UPDATE members SET is_active = true WHERE id = '{OWNER_TM}'")
        assert await _notices() == []


async def test_08_the_same_machine_counts_across_setups_but_never_across_organizations(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac h")
        a = device["agents"][0]["member_id"]
        same_machine = await _device(c, "d4863 mac h2")      # another setup of the SAME computer (same machine key, same organization)
        foreign = await _device(c, "d4863 mac h3")           # a setup that shares the machine key but belongs to ANOTHER organization
        mate, outsider = same_machine["agents"][0]["member_id"], foreign["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, same_machine, mate, "working", 1, key="s-m")
        await _report(c, foreign, outsider, "working", 1, key="s-f")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4863' WHERE id IN ('{device['setup_id']}', '{same_machine['setup_id']}', '{foreign['setup_id']}')",
                   f"UPDATE desktop_setups SET org_id = '{ORG2}' WHERE id = '{foreign['setup_id']}'")
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": [mate, outsider]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} 외 1개 · 꺼진 뒤 다시 서지 못함", "the mate on the same machine counts; the other organization's agent does not"


async def test_09_the_same_end_said_again_after_the_window_is_still_told_once(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1
        await _sql("UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE type = 'agent.restart_stopped'")  # the person's five minutes are over
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)  # a retry of the same end, late
        assert len(await _notices()) == 1, "this end was told already: a late retry is not a second notice"


async def test_10_a_database_error_inside_the_notice_does_not_undo_the_report(world, monkeypatch):
    """Not only a Python exception: a failed statement aborts the transaction — without its own savepoint the report that carried the field would be lost with it."""
    from sqlalchemy import text

    async with _client() as c:
        device = await _device(c, "d4863 mac j")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)

        import app.services.notification_dispatch as nd

        async def broken_statement(db, *_a, **_k):
            await db.execute(text("SELECT 1 FROM table_that_is_not_there_4863"))

        monkeypatch.setattr(nd, "dispatch_notification", broken_statement)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}})  # 200 — the record stands
        row = await _sql(fetch=f"SELECT state FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        assert row[0][0] == "stopped"


async def test_11_a_snapshot_cannot_carry_the_field(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac k")
        a = device["agents"][0]["member_id"]
        row = {"session_key": "s-1", "agent_member_id": a, "runtime": "claude", "state": "working", "at": _now().isoformat()}
        ok = await c.put("/api/v2/desktop/relay/sessions", headers=_tok(device["device_token"]), json={"report_seq": 1, "sessions": [row]})
        assert ok.status_code == 200, ok.text
        refused = await c.put("/api/v2/desktop/relay/sessions", headers=_tok(device["device_token"]),
                              json={"report_seq": 2, "sessions": [{**row, "state": "stopped", "restart_stopped": {"also": []}}]})
        assert refused.status_code == 422, "a snapshot lists live sessions and tells nobody: the field is refused, never dropped in silence"
        assert await _notices() == []


async def test_12_the_notice_comes_after_the_report_is_committed(world, monkeypatch):
    from app.services import desktop_restart_notice

    seen: list[str] = []
    real = desktop_restart_notice.tell

    async def spy(*args, **kwargs):
        rows = await _sql(fetch=f"SELECT state FROM desktop_sessions WHERE setup_id = '{args[1].id}' AND session_key = 's-1'")
        seen.append(rows[0][0] if rows else "no-row")  # read from ANOTHER connection: only a committed report is visible
        return await real(*args, **kwargs)

    monkeypatch.setattr(desktop_restart_notice, "tell", spy)
    async with _client() as c:
        device = await _device(c, "d4863 mac l")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}})
        assert seen == ["stopped"], "a claim made before the commit would be held for a notice a failed commit rolled back"
        assert len(await _notices()) == 1


async def test_13_an_agent_that_moved_away_is_not_counted_though_its_old_session_row_is_still_there(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac m")
        a = device["agents"][0]["member_id"]
        mate_setup = await _device(c, "d4863 mac m2")
        mate = mate_setup["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, mate_setup, mate, "working", 1, key="s-m")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4863-m' WHERE id IN ('{device['setup_id']}', '{mate_setup['setup_id']}')")
        await _sql(f"UPDATE desktop_setups SET members = '[]'::jsonb WHERE id = '{mate_setup['setup_id']}'")  # the mate was moved to another computer: its old row stays, the setup no longer has it
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": [mate]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함", "no «외 1개» for an agent that is no longer on this computer"


async def test_14_a_later_session_under_the_same_key_that_ends_again_is_a_new_notice(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac o")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1
        await _sql("UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE type = 'agent.restart_stopped'")
        await _report(c, device, a, "working", 3)  # a new session under the same key
        await _report(c, device, a, "stopped", 4, extra={"restart_stopped": {"also": []}}, at="2026-11-09T02:00:00+00:00")  # …and it ends from outside later
        assert len(await _notices()) == 2, "the key is reused; the end is not the same end"


async def test_15_one_persons_failed_notice_does_not_undo_or_block_the_other_and_the_retry_completes(world, monkeypatch):
    from sqlalchemy import text

    from tests.test_4685_limit_notice_realdb import PLAIN_TM, PLAIN_USER, _pair, _second_person

    await _second_person()
    async with _client() as c:
        device = await _device(c, "d4863 mac n")
        a = device["agents"][0]["member_id"]
        await _pair(device["setup_id"], OWNER_TM)
        await _pair(device["setup_id"], PLAIN_TM)  # two people hold this computer from their phones
        await _report(c, device, a, "working", 1)

        import app.services.notification_dispatch as nd

        real, calls = nd.dispatch_notification, {"n": 0}

        async def first_one_breaks(db, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                await db.execute(text("SELECT 1 FROM table_that_is_not_there_4863"))  # a failed statement: aborts the transaction unless it has its own savepoint
            return await real(db, *args, **kwargs)

        monkeypatch.setattr(nd, "dispatch_notification", first_one_breaks)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)
        told = [await _cards(OWNER), await _cards(PLAIN_USER)]
        assert sorted(told) == [0, 1], f"the person whose notice broke got none, the other still got theirs (got {told})"
        monkeypatch.setattr(nd, "dispatch_notification", real)
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)  # the daemon's retry
        assert [await _cards(OWNER), await _cards(PLAIN_USER)] == [1, 1], "the retry tells the one who was missed — and not the one already told"
        await _sql("UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE type = 'agent.restart_stopped'")  # their windows are over
        await _report(c, device, a, "stopped", 4, extra={"restart_stopped": {"also": []}}, at=AT0)  # a late retry
        assert [await _cards(OWNER), await _cards(PLAIN_USER)] == [1, 1], "nobody is told the same end twice, whatever failed before"


async def test_16_a_member_of_one_setup_with_a_stale_session_row_in_another_is_not_counted(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac p")
        a = device["agents"][0]["member_id"]
        keeper = await _device(c, "d4863 mac p2")    # the setup the agent belongs to now — it has no session row of its own for the agent
        old = await _device(c, "d4863 mac p3")       # a setup the agent was in before: its row stays
        mate = old["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, old, mate, "working", 1, key="s-old")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4863-p' WHERE id IN ('{device['setup_id']}', '{keeper['setup_id']}', '{old['setup_id']}')")
        await _sql(f"UPDATE desktop_setups SET members = '[]'::jsonb WHERE id = '{old['setup_id']}'",   # the old setup no longer has the agent…
                   f"UPDATE desktop_setups SET members = '{{}}'::jsonb || (SELECT members FROM desktop_setups WHERE id = '{old['setup_id']}') WHERE false")
        await _sql(f"UPDATE desktop_setups SET members = jsonb_build_array(jsonb_build_object('member_id', '{mate}', 'kind', 'agent', 'stage', 'x')) WHERE id = '{keeper['setup_id']}'")  # …the other one does, but holds no session of it
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": [mate]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함", "membership and the session row must be in the SAME setup"


async def test_17_no_session_level_advisory_lock_is_ever_left_on_a_connection(world, monkeypatch):
    """The per-person lock is `pg_advisory_xact_lock` (transaction scope): after a report — told, failed or folded — no advisory lock is held by any connection (a session-scope lock would stay on a pooled one)."""
    import inspect

    from app.services import desktop_restart_notice

    source = inspect.getsource(desktop_restart_notice)
    assert "pg_advisory_xact_lock" in source and "pg_advisory_lock" not in source.replace("pg_advisory_xact_lock", ""), "transaction scope only"
    async with _client() as c:
        device = await _device(c, "d4863 mac q")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)  # told
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)  # recognised: nothing new
        import app.services.notification_dispatch as nd

        async def broken(db, *_a, **_k):
            raise RuntimeError("down")

        monkeypatch.setattr(nd, "dispatch_notification", broken)
        await _report(c, device, a, "stopped", 4, extra={"restart_stopped": {"also": []}}, at="2026-11-09T03:00:00+00:00")  # failed
        held = await _sql(fetch="SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())")  # (this database only: lanes share one PG cluster)
        assert held[0][0] == 0, "nothing may keep an advisory lock after the transaction"


async def test_18_a_retry_is_recognised_within_the_lookback_only(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac r")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1
        await _sql("UPDATE notifications SET created_at = now() - interval '2 days' WHERE type = 'agent.restart_stopped'")
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 2, "the lookup reads the person's recent notices only — days later the same text is a new notice, not a scan of everything they ever had"


async def test_19_two_reports_at_once_for_one_person_are_ordered_into_one_notice(world):
    import asyncio

    async with _client() as c:
        d1, d2 = await _device(c, "d4863 mac s1"), await _device(c, "d4863 mac s2")
        a1, a2 = d1["agents"][0]["member_id"], d2["agents"][0]["member_id"]
        await _report(c, d1, a1, "working", 1)
        await _report(c, d2, a2, "working", 1)
        await asyncio.gather(
            _report(c, d1, a1, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0),
            _report(c, d2, a2, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0),
        )
        assert len(await _notices()) == 1, "without the per-person lock both read «no notice yet» and both tell"


async def test_20_the_same_end_with_its_time_in_another_offset_is_the_same_end(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac t")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at="2026-11-09T10:00:00+09:00")
        assert len(await _notices()) == 1
        await _sql("UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE type = 'agent.restart_stopped'")  # the window is over: only the same-end record is left to stop a repeat
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at="2026-11-09T01:00:00+00:00")  # the same instant, spelled in UTC
        assert len(await _notices()) == 1, "an end is an instant: two spellings of it are one end"


async def test_21_a_dispatcher_that_says_told_without_writing_the_notification_row_is_not_told(world, monkeypatch):
    async with _client() as c:
        device = await _device(c, "d4863 mac u")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)

        import app.services.notification_dispatch as nd

        real = nd.dispatch_notification

        async def bell_only(db, *args, **kwargs):
            kwargs.pop("created_rows", None)  # …nothing made is reported back, as when the Notification insert failed and only the bell line was written
            await real(db, *args, **kwargs)
            return 1

        monkeypatch.setattr(nd, "dispatch_notification", bell_only)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert await _notices() == [], "not told: the savepoint took the half-written line back"
        monkeypatch.setattr(nd, "dispatch_notification", real)
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}}, at=AT0)
        assert len(await _notices()) == 1, "the retry tells the person whole"


async def test_22_a_revoked_setup_of_the_same_machine_does_not_count(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac v")
        a = device["agents"][0]["member_id"]
        gone = await _device(c, "d4863 mac v2")
        mate = gone["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, gone, mate, "working", 1, key="s-g")
        await _sql(f"UPDATE desktop_setups SET machine_key = 'mk-4863-v' WHERE id IN ('{device['setup_id']}', '{gone['setup_id']}')")
        await _sql(f"UPDATE desktop_setups SET revoked_at = now() WHERE id = '{gone['setup_id']}'")  # that setup was revoked: its agents are not this computer's any more
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": [mate]}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함", "a revoked setup's agent is not «another agent of this computer»"


async def test_23_the_window_is_measured_by_the_clock_not_by_the_start_of_the_transaction(world):
    """A report that waited for the person's lock reads «five minutes ago» at the moment it looks, not at the moment its transaction began (`now()` is the start): with the lock held 3.5 s and a notice
    297 s old, the clock says 300.5 s — outside the window, so the new end IS told; the transaction start would say 297 s — inside, and the notice would be silently dropped."""
    import asyncio

    from sqlalchemy import func, select

    from app.core.database import async_session_factory

    async with _client() as c:
        device = await _device(c, "d4863 mac w")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _sql(f"INSERT INTO notifications (id, org_id, user_id, type, title, body, is_read, created_at) VALUES "
                   f"(gen_random_uuid(), '{ORG}', '{OWNER}', 'agent.restart_stopped', 'earlier', 'earlier', false, now() - interval '297 seconds')")

        async def hold_the_persons_lock():
            async with async_session_factory() as s:
                await s.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"restart_notice:{ORG}:{OWNER}", 0))))
                await asyncio.sleep(3.5)  # the lock is held while the report below starts its transaction and waits
                await s.commit()

        holder = asyncio.create_task(hold_the_persons_lock())
        await asyncio.sleep(0.6)  # (the holder has the lock before the report starts)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}}, at="2026-11-09T04:00:00+00:00")
        await holder
        rows = await _sql(fetch=f"SELECT count(*) FROM notifications WHERE type = 'agent.restart_stopped' AND user_id = '{OWNER}'")
        assert rows[0][0] == 2, "the new end is told: the earlier notice is already older than the window by the clock"
