"""story #4554 (E-2선 · 서버 · PO 11:45Z decisions on AC0 `nwachukwu/4554-ac0.md`) — the device relay's five edges, each a named number.

① rows: an ended session is kept ENDED_SESSION_RETENTION (7 d) · a device keeps SESSION_ROWS_PER_DEVICE (200) rows, the oldest ended
   going first, a live-only device refusing a new key (422 too_many_sessions) · a person's read is live-first, newest-first, `limit`
   (50 · ≤200).
② Last-Event-ID: not a number → 400 invalid_last_event_id before the stream opens · past the latest or past int32 → from after the
   latest (nothing sent again · no DB error).
③ report_seq past int32 → 422 report_seq_out_of_range (never 500) · a snapshot resets the baseline (a lower seq is taken and becomes
   the new baseline) · a new device token resets it to 0 · the single-state report keeps «after the latest».
④ a disconnected device: its live token is what «heard from» counts (unknown at once) · its open commands end rejected
   device_disconnected · its open stream ends with access_revoked now, not at the 30-second check.
⑤ the last stream of a device takes its queue-map key with it.
Measured before (AC0 probe): 300 keys → 300 rows · '-7' resent everything · '99999999999' → empty 200 + DataError · 2147483648 → 500
then 409 for ever · DELETE then view = working · key left with an empty set.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    OWNER,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _person,
    _sql,
    anyio_backend,
    world,
)
from tests.test_4529_desktop_relay_realdb import _device, _enqueue, _remote_control_on, _tok  # noqa: F401

pytestmark = pytest.mark.anyio

STREAM = "/api/v2/desktop/relay/stream"
SNAP = "/api/v2/desktop/relay/sessions"


def _state(agent, seq, state="working", at="2026-10-07T12:00:00Z"):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": at}


def _snap(agent, seq, keys, state="working"):
    one = {k: v for k, v in _state(agent, seq, state).items() if k != "report_seq"}
    return {"report_seq": seq, "sessions": [{"session_key": k, **one} for k in keys]}


def _code(r) -> tuple[int, str | None]:
    body = r.json()
    err = body.get("error") if isinstance(body, dict) else None
    code = (err or {}).get("code") if isinstance(err, dict) else (body.get("detail") or {}).get("code") if isinstance(body, dict) else None
    return r.status_code, code


async def _rows(sid) -> list[tuple]:
    return [tuple(r) for r in await _sql(fetch=f"SELECT session_key, state, last_report_seq FROM desktop_sessions WHERE setup_id = '{sid}' ORDER BY session_key")]


def _short_stream(monkeypatch, seconds: float):
    import app.routers.desktop_relay as router_mod

    monkeypatch.setattr(router_mod, "_LIFESPAN_SEC", seconds)
    monkeypatch.setattr(router_mod, "_LIFESPAN_JITTER_SEC", 0)


async def test_02_last_event_id_not_a_number_is_400_and_past_the_latest_sends_nothing_again(world, monkeypatch):
    _short_stream(monkeypatch, 1)
    async with _client() as c:
        d = await _device(c, name="d4554 lei")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        await _enqueue(sid, "start_session", {"agent_member_id": agent, "runtime": "claude"}, "k1")
        await _enqueue(sid, "stop_session", {"session_key": "s-1", "signed": "sig"}, "k2")
        first = await c.get(STREAM, headers=_tok(token))  # no cursor: both, as before
        assert first.status_code == 200 and first.text.count("event: command") == 2

        for bad in ("abc", "-7", "1e3", "+1", "1.0", "0x10"):
            r = await c.get(STREAM, headers={**_tok(token), "Last-Event-ID": bad})
            assert _code(r) == (400, "invalid_last_event_id"), (bad, r.text)
        # no header · an empty one (HTTP strips a whitespace-only value to empty): no cursor — from the start, as before
        r = await c.get(STREAM, headers={**_tok(token), "Last-Event-ID": ""})
        assert r.status_code == 200 and r.text.count("event: command") == 2
        # a real cursor still resumes after it (unchanged)
        r = await c.get(STREAM, headers={**_tok(token), "Last-Event-ID": "1"})
        assert r.text.count("event: command") == 1 and "id: 2\n" in r.text
        # past the latest · past int32 · absurdly long: from after the latest — nothing again, the stream lives to its end, no error
        for beyond in ("3", "99999999999", "2147483648", "9" * 20):
            r = await c.get(STREAM, headers={**_tok(token), "Last-Event-ID": beyond})
            assert r.status_code == 200, beyond
            assert r.text.count("event: command") == 0 and r.text.rstrip().endswith("event: lifespan_reconnect\ndata: {}"), (beyond, r.text)
        # «from after the latest» is a cursor, not a hole: a command made while such a stream is open still comes down (the wake)
        _short_stream(monkeypatch, 3)
        stream = asyncio.create_task(c.get(STREAM, headers={**_tok(token), "Last-Event-ID": "2147483648"}))
        await asyncio.sleep(0.8)
        await _enqueue(sid, "stop_session", {"session_key": "s-2", "signed": "sig"}, "k3")
        body = (await stream).text
        assert body.count("event: command") == 1 and "id: 3\n" in body, body


async def test_03_report_seq_past_int32_is_422_a_snapshot_resets_the_baseline_a_new_token_resets_it_to_0(world):
    from app.core.database import async_session_factory
    from app.services import desktop_relay as relay

    async with _client() as c:
        d = await _device(c, name="d4554 seq")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        url = "/api/v2/desktop/relay/sessions/s-1/state"
        assert _code(await c.post(url, json=_state(agent, 2_147_483_648), headers=_tok(token))) == (422, "report_seq_out_of_range")
        assert _code(await c.put(SNAP, json=_snap(agent, 2_147_483_648, ["s-1"]), headers=_tok(token))) == (422, "report_seq_out_of_range")
        assert await _rows(sid) == []
        assert (await c.post(url, json=_state(agent, 2_147_483_647), headers=_tok(token))).status_code == 200  # the edge itself is a number
        # the single-state report keeps «after the latest»
        assert _code(await c.post(url, json=_state(agent, 5), headers=_tok(token))) == (409, "stale_report")
        # a snapshot is the daemon's whole truth: a lower number is taken and becomes the baseline (a state file that went back to 0)
        snap = await c.put(SNAP, json=_snap(agent, 1, ["s-1", "s-2"]), headers=_tok(token))
        assert snap.status_code == 200, snap.text
        assert await _rows(sid) == [("s-1", "working", 1), ("s-2", "working", 1)]
        assert (await c.post(url, json=_state(agent, 2, "idle"), headers=_tok(token))).status_code == 200  # delta after the snapshot
        assert _code(await c.post(url, json=_state(agent, 1), headers=_tok(token))) == (409, "stale_report")
        assert _code(await c.post(url, json=_state(agent, 2), headers=_tok(token))) == (409, "stale_report")
        # a new device token (a reinstall · §1.1): the baseline goes to 0 with it — the first report from 1 is taken
        async with async_session_factory() as s:
            setup = await s.get(__import__("app.models.desktop_setup", fromlist=["DesktopSetup"]).DesktopSetup, uuid.UUID(sid))
            new_token = await relay.issue_device_token(s, setup.id)
            await s.commit()
        assert [r[2] for r in await _rows(sid)] == [0, 0]
        assert (await c.post(url, json=_state(agent, 1, "working"), headers=_tok(new_token))).status_code == 200


async def test_01_rows_are_kept_7_days_and_200_per_device_live_first_in_a_persons_read(world, monkeypatch):
    from app.services import desktop_relay as relay

    monkeypatch.setattr(relay, "SESSION_ROWS_PER_DEVICE", 5)  # the mechanism; the number itself is pinned below
    assert relay.SESSION_ROWS_PER_DEVICE == 5 and relay.ENDED_SESSION_RETENTION.days == 7 and (relay.SESSIONS_PAGE_DEFAULT, relay.SESSIONS_PAGE_MAX) == (50, 200)
    async with _client() as c:
        d = await _device(c, name="d4554 rows")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        post = lambda key, seq, state: c.post(f"/api/v2/desktop/relay/sessions/{key}/state", json=_state(agent, seq, state), headers=_tok(token))  # noqa: E731

        # ended rows: a device fills to 5, the 6th key drops the oldest ended row — never a live one
        for i in range(1, 6):
            assert (await post(f"e{i}", i, "stopped")).status_code == 200
        await _sql(f"UPDATE desktop_sessions SET ended_at = '2026-10-0{1}T00:00:00Z'::timestamptz + (right(session_key, 1)::int * interval '1 hour') WHERE setup_id = '{sid}'")
        assert (await post("e6", 6, "stopped")).status_code == 200
        keys = {r[0] for r in await _rows(sid)}
        assert len(keys) == 5 and "e1" not in keys and "e6" in keys  # the oldest ended went
        # retention: an ended row older than 7 days goes with the next report, a younger one stays
        await _sql(f"UPDATE desktop_sessions SET ended_at = now() - interval '8 days' WHERE setup_id = '{sid}' AND session_key = 'e2'",
                   f"UPDATE desktop_sessions SET ended_at = now() - interval '6 days' WHERE setup_id = '{sid}' AND session_key = 'e3'")
        assert (await post("e6", 7, "stopped")).status_code == 200  # an existing key: a report, no new row
        keys = {r[0] for r in await _rows(sid)}
        assert "e2" not in keys and "e3" in keys

        # live rows are never dropped: 5 live keys fill the device, the 6th live key is refused — nothing written
        await _sql(f"DELETE FROM desktop_sessions WHERE setup_id = '{sid}'")
        for i in range(1, 6):
            assert (await post(f"l{i}", 10 + i, "working")).status_code == 200
        assert _code(await post("l6", 16, "working")) == (422, "too_many_sessions")
        assert len(await _rows(sid)) == 5 and (await c.put(SNAP, json=_snap(agent, 17, [f"l{i}" for i in range(1, 6)]), headers=_tok(token))).status_code == 200
        # a snapshot of 5 new keys over 5 live ones: the old live rows become ended by the snapshot — but room is made before that,
        # on live rows → refused whole (all or nothing)
        assert _code(await c.put(SNAP, json=_snap(agent, 18, [f"m{i}" for i in range(1, 6)]), headers=_tok(token))) == (422, "too_many_sessions")
        assert {r[0] for r in await _rows(sid)} == {f"l{i}" for i in range(1, 6)}

        # a person's read: live first, newest first, `limit`
        await _sql(f"DELETE FROM desktop_sessions WHERE setup_id = '{sid}'")
        monkeypatch.setattr(relay, "SESSION_ROWS_PER_DEVICE", 200)
        for i in range(1, 8):
            assert (await post(f"k{i}", 20 + i, "stopped" if i <= 4 else "working", )).status_code == 200
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert [v["session_key"] for v in view][:3] == ["k7", "k6", "k5"] and len(view) == 7  # live first (newest first), then ended
        assert [v["state"] for v in view] == ["working"] * 3 + ["stopped"] * 4
        two = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions?limit=2", headers=_person(OWNER))).json()["sessions"]
        assert [v["session_key"] for v in two] == ["k7", "k6"]
        assert (await c.get(f"/api/v2/desktop/setups/{sid}/sessions?limit=201", headers=_person(OWNER))).status_code == 422
        assert (await c.get(f"/api/v2/desktop/setups/{sid}/sessions?limit=0", headers=_person(OWNER))).status_code == 422


async def test_04_a_disconnected_device_is_unknown_at_once_its_commands_rejected_its_stream_ended(world, monkeypatch):
    _short_stream(monkeypatch, 6)
    async with _client() as c:
        d = await _device(c, name="d4554 gone")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        assert (await c.put(SNAP, json=_snap(agent, 1, ["s-1"]), headers=_tok(token))).status_code == 200
        stream = asyncio.create_task(c.get(STREAM, headers=_tok(token)))
        await asyncio.sleep(0.8)  # open · read once · waiting for a wake (its 30-second recheck is longer than this stream lives)
        cmd = await _enqueue(sid, "stop_session", {"session_key": "s-1", "signed": "sig"}, "late")
        await asyncio.sleep(0.5)  # delivered down the open stream
        started = time.monotonic()
        r = await c.delete(f"/api/v2/desktop/setups/{sid}", headers=_person(OWNER))
        assert r.status_code == 200, r.text
        body = (await stream).text
        # the stream ended on the disconnect's own signal: access_revoked, well before its 6-second lifespan and its 30-second check
        assert "event: access_revoked" in body and "device_disconnected" in body and "lifespan_reconnect" not in body, body
        assert time.monotonic() - started < 6
        # the open command ended rejected · the person's view is unknown now (the revoked token's last heartbeat no longer counts)
        rows = await _sql(fetch=f"SELECT state, result_code FROM desktop_commands WHERE id = '{cmd.id}'")
        assert tuple(rows[0]) == ("rejected", "device_disconnected")
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert [(v["session_key"], v["state"], v["activity"]) for v in view] == [("s-1", "unknown", "unknown")]


async def test_05_the_last_stream_takes_its_queue_key_with_it(world, monkeypatch):
    from app.routers.events import _agent_connections
    from app.services import desktop_relay as relay

    _short_stream(monkeypatch, 1)
    async with _client() as c:
        d = await _device(c, name="d4554 key")
        key = relay.wake_key(uuid.UUID(d["setup_id"]))
        tok = _tok(d["device_token"])
        first = asyncio.create_task(c.get(STREAM, headers=tok))
        second = asyncio.create_task(c.get(STREAM, headers=tok))
        await asyncio.sleep(0.4)
        assert len(_agent_connections.get(key, ())) == 2  # both open
        assert (await first).status_code == 200 and (await second).status_code == 200
        assert key not in _agent_connections  # the last one out took the key


def test_00_the_numbers_are_what_the_contract_says():
    from app.services import desktop_relay as relay

    assert relay.INT32_MAX == 2_147_483_647
    assert relay.SESSION_ROWS_PER_DEVICE == 200
    assert relay.ENDED_SESSION_RETENTION.days == 7
    assert (relay.SESSIONS_PAGE_DEFAULT, relay.SESSIONS_PAGE_MAX) == (50, 200)
    assert relay.DISCONNECTED_CODE == "device_disconnected"
