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
    from app.services import desktop_restart_notice

    desktop_restart_notice._local.clear()  # the window and the once-per-session claims live in this process without Redis: each test starts with none
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", extra=None, expect=200):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat(), **(extra or {})}
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _notices(member=OWNER_TM):
    rows = await _sql(fetch=("SELECT payload FROM events WHERE recipient_id = :m AND event_type = 'dispatched' "
                             "AND payload->>'event_type' = :t ORDER BY created_at"), params={"m": member, "t": TYPE})
    return [r[0] for r in rows]


async def test_01_a_stopped_report_that_says_nobody_started_it_again_tells_the_person_once(world):
    async with _client() as c:
        device = await _device(c, "d4863 mac a")
        agent = device["agents"][0]["member_id"]
        await _report(c, device, agent, "working", 1)
        await _report(c, device, agent, "stopped", 2)  # the end itself (the daemon says it at once)
        assert await _notices() == [], "an ended session alone is not this notice: the app may well start it again"
        await _report(c, device, agent, "stopped", 3, extra={"restart_stopped": {"also": []}})
        (n,) = await _notices()
        assert n["title"] == f"{n['agent_name']} · 꺼진 뒤 다시 서지 못함"
        assert n["body"] == "밖에서 꺼진 뒤 다시 띄우지 못했어요. 이 컴퓨터의 Sprintable 앱을 열어 확인해 주세요."
        # nothing of the computer in the words: no path, no user name, no key
        assert "/" not in n["body"] and "~" not in n["body"] and "sdt_" not in str(n)
        # the same session said again (a retry after a lost answer) is not told again
        await _report(c, device, agent, "stopped", 4, extra={"restart_stopped": {"also": []}})
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
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}})  # 200 — the record stands
        row = await _sql(fetch=f"SELECT state FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        assert row[0][0] == "stopped"
        # …and since nobody was told, the same session said again IS told (the claim was let go)
        monkeypatch.undo()
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}})
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


async def test_09_the_same_session_said_again_after_the_window_is_still_told_once(world):
    from app.services import desktop_restart_notice

    async with _client() as c:
        device = await _device(c, "d4863 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "working", 1)
        await _report(c, device, a, "stopped", 2, extra={"restart_stopped": {"also": []}})
        assert len(await _notices()) == 1
        for k in [k for k in desktop_restart_notice._local if ":window:" in k]:
            del desktop_restart_notice._local[k]  # the person's five minutes are over
        await _report(c, device, a, "stopped", 3, extra={"restart_stopped": {"also": []}})  # a retry of the same session's saying, late
        assert len(await _notices()) == 1, "the session was told already: a late retry is not a second notice"


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
