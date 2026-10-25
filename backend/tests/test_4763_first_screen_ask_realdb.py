"""story #4763 (AC4 · AC12 · PO 10-24 · design-ac4) — the web and the phone say «Mac에서 답을 기다려요» while a session's first-screen question stands (folder trust · new MCP server(s) · Codex's update).

Server half: the report carries `first_screen` (one closed word, `trust`), the row keeps it (migration 0465), both readers show it (the DM/strip
header and the device's session list); a report without it clears it (the question is gone). It cannot freeze: a computer that went quiet says
nothing of it (the app quit · the network dropped), a stopped or dropped session holds none (PO 21:59Z). Each claim has a test that goes red without it.
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


@pytest.fixture(autouse=True)
async def _remote_control_on_and_korean(world):
    await _sql(f"UPDATE organizations SET remote_control_enabled_at = now() WHERE id = '{ORG}'",
               f"UPDATE users SET locale = 'ko' WHERE id = '{OWNER}'")
    yield


def _now():
    return datetime.now(timezone.utc)


async def _report(c, device, agent, state, seq, *, key="s-1", first_screen=None, expect=200):
    body = {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat()}
    if first_screen is not None:
        body["first_screen"] = first_screen
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
    return await _sql(fetch=f"SELECT first_screen_ask FROM desktop_sessions WHERE setup_id = '{device['setup_id']}' AND session_key = '{key}'")


ASKS = ["trust", "mcp", "mcp_many", "update"]  # the daemon's own list (4528)


@pytest.mark.parametrize("ask", ASKS)
async def test_01_the_report_keeps_it_and_both_readers_show_it(world, ask):
    async with _client() as c:
        device = await _device(c, f"d4763 mac a{ASKS.index(ask)}")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, first_screen={"ask": ask})
        h = await _header(c, a)
        assert h["first_screen"] == {"ask": ask} and h["activity"] == "starting"  # the strip (web) and the phone's — the same component
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["first_screen"] == {"ask": ask}  # the device's session list
        assert await _column(device) == [(ask,)]
        # the question CHANGES (trust answered → the project's MCP servers asked next): the new word replaces the old one
        other = "mcp" if ask != "mcp" else "update"
        await _report(c, device, a, "starting", 2, first_screen={"ask": other})
        assert (await _header(c, a))["first_screen"] == {"ask": other}


async def test_02_a_report_without_it_clears_it_the_question_is_gone(world):
    """The question was answered → the next report has no `first_screen` → the line goes. Never a stale question."""
    async with _client() as c:
        device = await _device(c, "d4763 mac b")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, first_screen={"ask": "trust"})
        assert (await _header(c, a))["first_screen"] == {"ask": "trust"}
        await _report(c, device, a, "working", 2)  # the agent runs now (or an older daemon)
        assert (await _header(c, a))["first_screen"] is None
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "first_screen" not in row
        assert await _column(device) == [(None,)]


async def test_03_the_snapshot_path_carries_it_too_and_a_dropped_session_loses_it(world):
    async with _client() as c:
        device = await _device(c, "d4763 mac c")
        a, b = device["agents"][0]["member_id"], device["agents"][1]["member_id"]
        snap = {"report_seq": 1, "sessions": [
            {"session_key": "s-a", "agent_member_id": a, "runtime": "claude", "state": "starting", "at": _now().isoformat(), "first_screen": {"ask": "trust"}},
            {"session_key": "s-b", "agent_member_id": b, "runtime": "claude", "state": "starting", "at": _now().isoformat(), "first_screen": {"ask": "trust"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-a"]["first_screen"] == {"ask": "trust"} and rows["s-b"]["first_screen"] == {"ask": "trust"}
        snap2 = {"report_seq": 2, "sessions": [snap["sessions"][0]]}  # s-b is gone from the daemon's list (the app quit and came back)
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap2, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert rows["s-b"]["state"] == "stopped" and "first_screen" not in rows["s-b"]
        assert await _column(device, "s-b") == [(None,)]  # the column itself — the reader's own `stopped` guard would hide a leftover
        snap3 = {"report_seq": 3, "sessions": [{k: v for k, v in snap["sessions"][0].items() if k != "first_screen"}]}  # answered meanwhile
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap3, headers=_tok(device["device_token"]))).status_code == 200
        rows = {s["session_key"]: s for s in await _list(c, device)}
        assert "first_screen" not in rows["s-a"] and await _column(device, "s-a") == [(None,)]


@pytest.mark.parametrize("bad", [
    {"ask": "login"}, {"ask": "theme"}, {"ask": "mcp_few"}, {"ask": "MCP"}, {"ask": "Trust"}, {"ask": "trust "}, {"ask": "trust\n"}, {"ask": ""}, {"ask": None}, {"ask": 1}, {"ask": ["trust"]}, {},
    {"ask": "trust", "folder": "/Users/x/secret"},  # a field the contract does not have — no path ever
    {"ask": "trust", "text": "Quick safety check"},
    "trust", ["trust"], 1, True,  # not an object
])
async def test_04_what_is_not_the_one_word_is_refused(world, bad):
    async with _client() as c:
        device = await _device(c, "d4763 mac d")
        a = device["agents"][0]["member_id"]
        body = {"report_seq": 1, "agent_member_id": a, "runtime": "claude", "state": "starting", "at": _now().isoformat(), "first_screen": bad}
        r = await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)
        assert r.status_code == 422, r.text


async def test_05_a_device_that_went_quiet_says_nothing_of_it_it_cannot_freeze(world):
    """The app quit or the network dropped with the question standing: the column is still `trust`, but the readers go by the device's silence
    (the same gate as the session's own word, which turns `unknown`) — the strip never shows an old «Mac에서 답을 기다려요»."""
    async with _client() as c:
        device = await _device(c, "d4763 mac e")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, first_screen={"ask": "trust"})
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{device['setup_id']}'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "unknown" and "first_screen" not in row
        h = await _header(c, a)
        assert h["activity"] == "unknown" and h["first_screen"] is None
        assert await _column(device) == [("trust",)]  # the evidence is that the column alone does not decide
        # the device is heard again with the question still standing → it shows again (the silence did not erase a true fact)
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() WHERE setup_id = '{device['setup_id']}'")
        assert (await _header(c, a))["first_screen"] == {"ask": "trust"}


async def test_06_a_stopped_session_keeps_none_and_says_none(world):
    """Like `inbox` (4684): accepted, never stored or shown — an ended session asks nothing."""
    async with _client() as c:
        device = await _device(c, "d4763 mac f")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, first_screen={"ask": "trust"})
        await _report(c, device, a, "stopped", 2, first_screen={"ask": "trust"})  # «끝내기» ends the agent; the daemon says «stopped» and may still carry it
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "first_screen" not in row
        assert await _column(device) == [(None,)]
        # defense in depth: even a leftover value on an ended row is not told as current
        await _sql(f"UPDATE desktop_sessions SET first_screen_ask = 'trust' WHERE setup_id = '{device['setup_id']}' AND session_key = 's-1'")
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert row["state"] == "stopped" and "first_screen" not in row
        assert (await _header(c, a))["first_screen"] is None


async def test_07_the_database_holds_the_closed_set(world):
    """The API check is not the last word: the DB refuses a word that is not one of the four."""
    import sqlalchemy.exc

    async with _client() as c:
        device = await _device(c, "d4763 mac g")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1)
        for val in ("'login'", "'trust '", "'mcp_few'", "'x'", "''"):
            with pytest.raises(Exception) as e:
                await _sql(f"UPDATE desktop_sessions SET first_screen_ask = {val} WHERE setup_id = '{device['setup_id']}'")
            # refused BY THIS CHECK (not by some other constraint, and not merely "an error")
            assert isinstance(e.value, sqlalchemy.exc.IntegrityError) and "ck_desktop_sessions_first_screen_ask" in str(e.value), str(e.value)[:200]
        # the positive control: each of the four words is accepted at the same place (so the refusals above are the check, not a broken statement)
        for val in ("'trust'", "'mcp'", "'mcp_many'", "'update'", "NULL"):
            await _sql(f"UPDATE desktop_sessions SET first_screen_ask = {val} WHERE setup_id = '{device['setup_id']}'")


async def test_08_the_new_field_does_not_move_the_others_and_is_not_said_when_there_is_none(world):
    """One more field rides beside limit / run / inbox — it must not move them, and a session that asks nothing says nothing."""
    async with _client() as c:
        device = await _device(c, "d4763 mac h")
        a = device["agents"][0]["member_id"]
        body = {"report_seq": 1, "agent_member_id": a, "runtime": "claude", "state": "starting", "at": _now().isoformat(),
                "run": {"model": "claude-sonnet-5-5", "model_set": True}, "inbox": {"stream": "stopped_other_receiver"}, "first_screen": {"ask": "trust"}}
        r = await c.post("/api/v2/desktop/relay/sessions/s-1/state", headers=_tok(device["device_token"]), json=body)
        assert r.status_code == 200, r.text
        h = await _header(c, a)
        assert h["run"] == {"model": "claude-sonnet-5-5", "model_set": True} and h["inbox"] == {"stream": "stopped_other_receiver"}
        assert h["first_screen"] == {"ask": "trust"}
        await _report(c, device, a, "idle", 2)
        assert (await _header(c, a))["first_screen"] is None
        (row,) = [s for s in await _list(c, device) if s["session_key"] == "s-1"]
        assert "first_screen" not in row


async def test_09_the_reader_is_the_one_who_may_read_the_session(world):
    """No new door: the header is the agent's `desktop-session` — a stranger gets the same 404 as before and never the question."""
    async with _client() as c:
        device = await _device(c, "d4763 mac i")
        a = device["agents"][0]["member_id"]
        await _report(c, device, a, "starting", 1, first_screen={"ask": "trust"})
        r = await c.get(f"/api/v2/agents/{a}/desktop-session", headers=_tok(device["device_token"]))  # the device's own token is not a reader
        assert r.status_code in (401, 403, 404), r.text
        assert "first_screen" not in r.text
