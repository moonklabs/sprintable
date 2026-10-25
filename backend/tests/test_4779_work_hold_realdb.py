"""story #4779 (AC3 · PO 10-25) — the web and the phone say WHY work is not reaching an agent whose computer cannot confirm (or has lost) the link to its Sprintable tools.

10-25 05:01Z: a lane stood 50 minutes with work waiting and no screen said so. Server half: the report carries `work_hold` (one closed word — `tools_unconfirmed` · `tools_failed`),
the row keeps it (migration 0466), both readers show it (the conversation strip's header and the device's session list); a report without it clears it (the hold is gone — and an
older daemon never sends it). It cannot freeze: a computer that went quiet says nothing of it, a stopped or dropped session holds none. Each claim has a test that goes red without it.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    ORG,
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _tok

pytestmark = pytest.mark.anyio

WHYS = ["tools_unconfirmed", "tools_failed"]


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", work_hold=None, expect=200, **more):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat(), **more}
    if work_hold is not None:
        body["work_hold"] = work_hold
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _header(c, agent) -> dict:
    return (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))).json()


async def _list(c, device) -> list[dict]:
    r = await c.get(f"/api/v2/desktop/setups/{device['setup_id']}/sessions", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


async def _column(device, key="s-1"):
    return await _sql(fetch=f"SELECT work_hold_why FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = '{key}'")


@pytest.mark.parametrize("why", WHYS)
async def test_01_the_report_keeps_it_and_both_readers_show_it(world, why):
    async with _client() as c:
        device = await _device(c, f"d4779 mac a{WHYS.index(why)}")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, work_hold={"why": why})
        h = await _header(c, a)
        assert h["work_hold"] == {"why": why} and h["activity"] == "idle"  # the strip (web) and the phone's — the same component
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["work_hold"] == {"why": why}  # the device's session list
        assert await _column(device) == [(why,)]
        # the hold CHANGES (unconfirmed for minutes → the app asked again and gave up): the new word replaces the old one
        other = "tools_failed" if why == "tools_unconfirmed" else "tools_unconfirmed"
        await _report(c, device, a, "idle", 2, work_hold={"why": other})
        assert (await _header(c, a))["work_hold"] == {"why": other}


async def test_02_a_report_without_it_clears_it_the_hold_is_gone(world):
    """The tools are confirmed (or the work went in) → the next report has no `work_hold` → the line goes. Never a stale hold — and an older daemon, which never sends it, shows none."""
    async with _client() as c:
        device = await _device(c, "d4779 mac b")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, work_hold={"why": "tools_unconfirmed"})
        assert (await _header(c, a))["work_hold"] == {"why": "tools_unconfirmed"}
        await _report(c, device, a, "working", 2)
        assert (await _header(c, a))["work_hold"] is None
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "work_hold" not in row
        assert await _column(device) == [(None,)]


async def test_03_the_snapshot_path_carries_it_too_and_a_dropped_session_loses_it(world):
    async with _client() as c:
        device = await _device(c, "d4779 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        snap = {"report_seq": 1, "sessions": [
            {"session_key": "s-a", "agent_member_id": a, "runtime": "claude", "state": "idle", "at": _now().isoformat(), "work_hold": {"why": "tools_failed"}},
            {"session_key": "s-b", "agent_member_id": b, "runtime": "claude", "state": "idle", "at": _now().isoformat(), "work_hold": {"why": "tools_unconfirmed"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-a"]["work_hold"] == {"why": "tools_failed"} and rows["s-b"]["work_hold"] == {"why": "tools_unconfirmed"}
        snap2 = {"report_seq": 2, "sessions": [snap["sessions"][0]]}  # s-b is gone from the daemon's list (the app quit and came back)
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap2, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-b"]["state"] == "stopped" and "work_hold" not in rows["s-b"]
        assert await _column(device, "s-b") == [(None,)]  # the column itself — the reader's own `stopped` guard would hide a leftover
        snap3 = {"report_seq": 3, "sessions": [{k: v for k, v in snap["sessions"][0].items() if k != "work_hold"}]}  # the tools came back meanwhile
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap3, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert "work_hold" not in rows["s-a"] and await _column(device, "s-a") == [(None,)]


@pytest.mark.parametrize("bad", [
    {"why": "tools"}, {"why": "tools_unconfirmed "}, {"why": "Tools_Failed"}, {"why": "tools_failed\n"}, {"why": "limit"}, {"why": ""}, {"why": None}, {"why": 1}, {"why": ["tools_failed"]}, {},
    {"why": "tools_failed", "path": "/Users/x/secret"},  # a field the contract does not have — no path ever
    {"why": "tools_failed", "account": "someone@example.com"},
    {"why": "tools_failed", "n": 3},
    "tools_failed", ["tools_failed"], 1, True,  # not an object
])
async def test_04_what_is_not_the_one_word_is_refused(world, bad):
    async with _client() as c:
        device = await _device(c, "d4779 mac d")
        a = device["agents"][0]["member_id"]
        body = {"report_seq": 1, "agent_member_id": a, "runtime": "claude", "state": "idle", "at": _now().isoformat(), "work_hold": bad}
        r = await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)
        assert r.status_code == 422, r.text


async def test_05_a_device_that_went_quiet_says_nothing_of_it_it_cannot_freeze(world):
    """The app quit or the network dropped with the hold standing: the column is still set, but the readers go by the device's silence (the same gate as the session's own word,
    which turns `unknown`) — the strip never shows an old «글이 멈춰 있어요»."""
    async with _client() as c:
        device = await _device(c, "d4779 mac e")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, work_hold={"why": "tools_unconfirmed"})
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "unknown" and "work_hold" not in row
        h = await _header(c, a)
        assert h["activity"] == "unknown" and h["work_hold"] is None
        assert await _column(device) == [("tools_unconfirmed",)]  # the evidence is that the column alone does not decide
        # the device is heard again with the hold still standing → it shows again (the silence did not erase a true fact)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{device['setup_id']}'")
        assert (await _header(c, a))["work_hold"] == {"why": "tools_unconfirmed"}


async def test_06_a_stopped_session_keeps_none_and_says_none(world):
    """Accepted, never stored or shown — an ended session holds no work."""
    async with _client() as c:
        device = await _device(c, "d4779 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, work_hold={"why": "tools_failed"})
        await _report(c, device, a, "stopped", 2, work_hold={"why": "tools_failed"})  # «끝내기» ends the agent; the daemon says «stopped» and may still carry it
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "work_hold" not in row
        assert await _column(device) == [(None,)]
        # defense in depth: even a leftover value on an ended row is not told as current
        await _sql(f"UPDATE desktop_sessions SET work_hold_why = 'tools_failed' WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "work_hold" not in row
        assert (await _header(c, a))["work_hold"] is None


async def test_07_the_database_holds_the_closed_set(world):
    """The API check is not the last word: the DB refuses a word that is not one of the two."""
    import sqlalchemy.exc

    async with _client() as c:
        device = await _device(c, "d4779 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1)
        for val in ("'tools'", "'tools_failed '", "'limit'", "'x'", "''"):
            with pytest.raises(Exception) as e:
                await _sql(f"UPDATE desktop_sessions SET work_hold_why = {val} WHERE setup_id = '{device['setup_id']}'")
            # refused BY THIS CHECK (not by some other constraint, and not merely "an error")
            assert isinstance(e.value, sqlalchemy.exc.IntegrityError) and "ck_desktop_sessions_work_hold_why" in str(e.value), str(e.value)[:200]
        # the positive control: each of the two words is accepted at the same place (so the refusals above are the check, not a broken statement)
        for val in ("'tools_unconfirmed'", "'tools_failed'", "NULL"):
            await _sql(f"UPDATE desktop_sessions SET work_hold_why = {val} WHERE setup_id = '{device['setup_id']}'")


async def test_08_the_new_field_does_not_move_the_others_and_is_not_said_when_there_is_none(world):
    """One more field rides beside limit / run / inbox / first_screen — it must not move them, and a session whose work is not held says nothing."""
    async with _client() as c:
        device = await _device(c, "d4779 mac h")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, run={"model": "claude-sonnet-5-5", "model_set": True}, inbox={"stream": "stopped_other_receiver"},
                      first_screen={"ask": "trust"}, work_hold={"why": "tools_unconfirmed"})
        h = await _header(c, a)
        assert h["run"] == {"model": "claude-sonnet-5-5", "model_set": True} and h["inbox"] == {"stream": "stopped_other_receiver"}
        assert h["first_screen"] == {"ask": "trust"} and h["work_hold"] == {"why": "tools_unconfirmed"}
        await _report(c, device, a, "idle", 2, run={"model": "claude-sonnet-5-5", "model_set": True})
        h = await _header(c, a)
        assert h["work_hold"] is None and h["first_screen"] is None and h["run"] == {"model": "claude-sonnet-5-5", "model_set": True}
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "work_hold" not in row and "first_screen" not in row


async def test_09_the_reader_is_the_one_who_may_read_the_session(world):
    """No new door: the header is the agent's `desktop-session` — a stranger gets the same 404 as before and never the hold."""
    async with _client() as c:
        device = await _device(c, "d4779 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, work_hold={"why": "tools_unconfirmed"})
        r = await c.get(f"/api/v2/agents/{a}/desktop-session", headers=_tok(device["device_token"]))  # the device's own token is not a reader
        assert r.status_code in (401, 403, 404), r.text
        assert "work_hold" not in r.text


@pytest.mark.parametrize("state", ["starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit"])
async def test_10_every_live_state_carries_it_work_waits_whatever_the_agent_is_doing(world, state):
    """Unlike the first-screen question (which only starting / working / idle rename), a hold is about WORK reaching the agent: it holds in any live state, and only an ended session holds none."""
    async with _client() as c:
        device = await _device(c, f"d4779 mac {state}")
        a = device["agents"][0]["member_id"]
        more = {"limit": {"at": "2026-12-01T00:00:00Z"}} if state in ("error", "paused_limit") else {}
        await _report(c, device, a, state, 1, work_hold={"why": "tools_failed"}, **more)
        assert await _column(device) == [("tools_failed",)]
        assert (await _header(c, a))["work_hold"] == {"why": "tools_failed"}
        (row,) = [x for x in await _list(c, device) if x["session_key"] == "s-1"]
        assert row["work_hold"] == {"why": "tools_failed"}
