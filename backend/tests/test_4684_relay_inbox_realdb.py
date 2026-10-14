"""story #4684 (PO 10-14 · Yuna ux1-copy §L ②③) — the phone and the web strip say it too when this computer stopped receiving an agent's work.

Server half: the report carries `inbox` (the app board's own closed stop words), the row keeps it (migration 0454), both readers show it (the
DM/strip header and the device's session list); a report without it clears it (the computer receives again — AC2). Each claim has a test that
goes red without it (mutants in the PR).
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

STOPS = ["stopped_other_receiver", "stopped_taken_over", "stopped_auth", "stopped_inbox_full"]


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", inbox=None, expect=200):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat()}
    if inbox is not None:
        body["inbox"] = inbox
    r = await c.post(f"/api/v2/desktop/relay/sessions/{key}/state", headers=_tok(device["device_token"]), json=body)
    assert r.status_code == expect, r.text
    return r


async def _header(c, agent) -> dict:
    return (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))).json()


async def _list(c, device) -> list[dict]:
    r = await c.get(f"/api/v2/desktop/setups/{device['setup_id']}/sessions", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


@pytest.mark.parametrize("stop", STOPS)
async def test_01_the_report_keeps_it_and_both_readers_show_it(world, stop):
    async with _client() as c:
        device = await _device(c, f"d4684 mac a{STOPS.index(stop)}")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, inbox={"stream": stop})
        assert (await _header(c, a))["inbox"] == {"stream": stop}  # the strip (web) and the phone's — the same component
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["inbox"] == {"stream": stop}  # the device's session list


async def test_02_a_report_without_inbox_clears_it_the_computer_receives_again(world):
    """AC2: the computer receives again → the next report has no `inbox` → the line goes. Never a stale stop."""
    async with _client() as c:
        device = await _device(c, "d4684 mac b")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, inbox={"stream": "stopped_other_receiver"})
        assert (await _header(c, a))["inbox"] == {"stream": "stopped_other_receiver"}
        await _report(c, device, a, "idle", 2)  # receives again (or an older daemon)
        assert (await _header(c, a))["inbox"] is None
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "inbox" not in row
        # and a stop that CHANGES replaces the old word (taken over after having been refused)
        await _report(c, device, a, "idle", 3, inbox={"stream": "stopped_other_receiver"})
        await _report(c, device, a, "idle", 4, inbox={"stream": "stopped_taken_over"})
        assert (await _header(c, a))["inbox"] == {"stream": "stopped_taken_over"}


async def test_03_the_snapshot_path_carries_it_too_and_a_dropped_session_loses_it(world):
    async with _client() as c:
        device = await _device(c, "d4684 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        snap = {"report_seq": 1, "sessions": [
            {"session_key": "s-a", "agent_member_id": a, "runtime": "claude", "state": "idle", "at": _now().isoformat(), "inbox": {"stream": "stopped_taken_over"}},
            {"session_key": "s-b", "agent_member_id": b, "runtime": "codex", "state": "idle", "at": _now().isoformat(), "inbox": {"stream": "stopped_auth"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-a"]["inbox"] == {"stream": "stopped_taken_over"} and rows["s-b"]["inbox"] == {"stream": "stopped_auth"}
        snap2 = {"report_seq": 2, "sessions": [snap["sessions"][0]]}  # s-b is gone from the daemon's list
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap2, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-b"]["state"] == "stopped" and "inbox" not in rows["s-b"]  # a dropped session explains no receive stop
        # … and the row itself holds none (the reader's own `stopped` guard would hide a leftover: the column is where it shows)
        assert await _sql(fetch=f"SELECT inbox_stream FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-b'") == [(None,)]
        # a snapshot line without `inbox` clears the stop (the computer receives again)
        snap3 = {"report_seq": 3, "sessions": [{k: v for k, v in snap["sessions"][0].items() if k != "inbox"}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap3, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert "inbox" not in rows["s-a"]


@pytest.mark.parametrize("bad", [
    {"stream": "open"}, {"stream": "closed"}, {"stream": "connecting"},  # the daemon's other statuses are not stops
    {"stream": "stopped_something_else"}, {"stream": "STOPPED_OTHER_RECEIVER"}, {"stream": "stopped_other_receiver "}, {"stream": "stopped_other_receiver\n"},
    {"stream": ""}, {"stream": None}, {"stream": 1}, {"stream": ["stopped_auth"]}, {},
    {"stream": "stopped_auth", "why": "key revoked"},  # a field the contract does not have
    "stopped_auth", ["stopped_auth"], 1, True,  # not an object
])
async def test_04_what_is_not_one_of_the_stop_words_is_refused(world, bad):
    async with _client() as c:
        device = await _device(c, "d4684 mac d")
        a = device["agents"][0]["member_id"]
        body = {"report_seq": 1, "agent_member_id": a, "runtime": "claude", "state": "idle", "at": _now().isoformat(), "inbox": bad}
        r = await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)
        assert r.status_code == 422, r.text


async def test_05_a_device_that_went_quiet_says_nothing_of_a_stop(world):
    async with _client() as c:
        device = await _device(c, "d4684 mac e")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, inbox={"stream": "stopped_taken_over"})
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "unknown" and "inbox" not in row  # a stop from before the silence is not told as current


async def test_06_a_stopped_session_keeps_no_stop_and_says_none(world):
    """Like `run` (4686): accepted, never stored or shown — an ended session explains no receive stop (and a 422 would only make a daemon give up)."""
    async with _client() as c:
        device = await _device(c, "d4684 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1, inbox={"stream": "stopped_other_receiver"})
        await _report(c, device, a, "stopped", 2, inbox={"stream": "stopped_other_receiver"})  # the daemon says «stopped» and still carries it
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "inbox" not in row
        assert await _sql(fetch=f"SELECT inbox_stream FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'") == [(None,)]
        # defense in depth: even a leftover value on an ended row is not told as current (the list reads `stopped` first)
        await _sql(f"UPDATE desktop_sessions SET inbox_stream = 'stopped_auth' WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "inbox" not in row
        assert (await _header(c, a))["inbox"] is None


async def test_07_the_database_holds_the_closed_set(world):
    """The API check is not the last word: the DB refuses a word that is not one of the four."""
    import sqlalchemy.exc

    async with _client() as c:
        device = await _device(c, "d4684 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "idle", 1)
        for val in ("'open'", "'stopped_other_receiver '", "'x'", "''"):
            with pytest.raises(Exception) as e:
                await _sql(f"UPDATE desktop_sessions SET inbox_stream = {val} WHERE setup_id = '{device['setup_id']}'")
            assert "ck_desktop_sessions_inbox_stream" in str(e.value) or isinstance(e.value, sqlalchemy.exc.IntegrityError)


async def test_08_a_report_with_the_stop_does_not_touch_the_other_row_fields(world):
    """The new column rides beside limit / run / system — one more field must not move the others."""
    async with _client() as c:
        device = await _device(c, "d4684 mac h")
        a = device["agents"][0]["member_id"]
        body = {"report_seq": 1, "agent_member_id": a, "runtime": "claude", "state": "waiting_input", "at": _now().isoformat(),
                "limit": {"self_resume": "maybe"}, "run": {"model": "claude-sonnet-5-5", "model_set": True}, "inbox": {"stream": "stopped_other_receiver"}}
        r = await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)
        assert r.status_code == 200, r.text
        h = await _header(c, a)
        assert h["limit"] == {"self_resume": "maybe"} and h["run"] == {"model": "claude-sonnet-5-5", "model_set": True} and h["inbox"] == {"stream": "stopped_other_receiver"}
