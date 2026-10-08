"""story #4554 (E-2선 · 서버 · PO 11:45Z decisions on AC0 `nwachukwu/4554-ac0.md`) — the device relay's five edges, each a named number.

① rows: an ended session is kept ENDED_SESSION_RETENTION (7 d) · a device keeps SESSION_ROWS_PER_DEVICE (200) rows, the oldest ended
   going first, a live-only device refusing a new key (422 too_many_sessions) · a person's read is live-first, newest-first, `limit`
   (50 · ≤200).
② Last-Event-ID: not a number → 400 invalid_last_event_id before the stream opens · past the latest or past int32 → from after the
   latest (nothing sent again · no DB error).
③ report_seq past int32 → 422 report_seq_out_of_range (never 500) · a snapshot obeys «after the latest» like a single report (Kadir
   4981 ①: a late snapshot never undoes newer state) · the 409 names the latest (the daemon takes latest + 1) · a new device token
   resets the baseline to 0.
④ a disconnected device: its live token is what «heard from» counts (unknown at once) · its open commands end rejected
   device_disconnected — an answer_approval's permission request with them (Kadir 4981 ②: never a false «answered») · its open
   stream ends with access_revoked now, not at the 30-second check. Remote control off takes the same path.
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
from tests.test_4533_agent_permissions_realdb import _answer, _ask, _pair, _post_ask, _register  # noqa: F401

pytestmark = pytest.mark.anyio

STREAM = "/api/v2/desktop/relay/stream"
SNAP = "/api/v2/desktop/relay/sessions"


def _state(agent, seq, state="working", at=None):
    # now, never a fixed date: a stopped report's `at` is its row's ended_at, which ages out after 7 days (a fixed 10-07 broke this
    # file on 10-14 · the fixed 10-01 below broke it on 10-08)
    at = at or datetime.now(timezone.utc).isoformat()
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
        # the single-state report keeps «after the latest» — and the refusal names the latest (the daemon takes latest + 1)
        late = await c.post(url, json=_state(agent, 5), headers=_tok(token))
        assert _code(late) == (409, "stale_report") and late.json()["error"]["detail"] == {"latest": 2_147_483_647}, late.text
        # Kadir 4981 ①: a snapshot obeys the same rule — a lower number is refused the same way, nothing written (mutant: the old
        # «a snapshot resets the baseline» line → 200 and rows at 1 → RED)
        snap = await c.put(SNAP, json=_snap(agent, 1, ["s-1", "s-2"]), headers=_tok(token))
        assert _code(snap) == (409, "stale_report") and snap.json()["error"]["detail"] == {"latest": 2_147_483_647}, snap.text
        assert await _rows(sid) == [("s-1", "working", 2_147_483_647)]
        # a new device token (a reinstall · §1.1 — the state file and the token live in one folder, §12): the baseline goes to 0
        # with it — the first report from 1 is taken, and the snapshot that follows is a delta on it
        async with async_session_factory() as s:
            setup = await s.get(__import__("app.models.desktop_setup", fromlist=["DesktopSetup"]).DesktopSetup, uuid.UUID(sid))
            new_token = await relay.issue_device_token(s, setup.id)
            await s.commit()
        assert [r[2] for r in await _rows(sid)] == [0]
        assert (await c.post(url, json=_state(agent, 1, "working"), headers=_tok(new_token))).status_code == 200
        assert (await c.put(SNAP, json=_snap(agent, 2, ["s-1", "s-2"]), headers=_tok(new_token))).status_code == 200
        assert await _rows(sid) == [("s-1", "working", 2), ("s-2", "working", 2)]


async def test_03b_a_late_snapshot_never_undoes_a_newer_report(world):
    """Kadir 4981 ① (codex probe, real DB): report seq 10 working → report seq 11 idle → a delayed snapshot seq 9 working (an HTTP
    retry of an older PUT · two daemon processes over a restart) — before this fix it was stored and shown as working at 9 and a
    seq 10 report was then taken again. Now: 409 stale_report naming 11 · the row stays idle at 11 · seq 10 is still refused · the
    daemon's next snapshot at 12 is taken."""
    async with _client() as c:
        d = await _device(c, name="d4554 late snap")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        url = "/api/v2/desktop/relay/sessions/s-1/state"
        assert (await c.post(url, json=_state(agent, 10, "working"), headers=_tok(token))).status_code == 200
        assert (await c.post(url, json=_state(agent, 11, "idle"), headers=_tok(token))).status_code == 200
        late = await c.put(SNAP, json=_snap(agent, 9, ["s-1"]), headers=_tok(token))
        assert _code(late) == (409, "stale_report") and late.json()["error"]["detail"] == {"latest": 11}, late.text
        assert await _rows(sid) == [("s-1", "idle", 11)]
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert [(v["session_key"], v["state"]) for v in view] == [("s-1", "idle")]
        assert _code(await c.post(url, json=_state(agent, 10, "working"), headers=_tok(token))) == (409, "stale_report")
        assert (await c.put(SNAP, json=_snap(agent, 12, ["s-1"], "working"), headers=_tok(token))).status_code == 200
        assert await _rows(sid) == [("s-1", "working", 12)]


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
        # ended inside the 7 days (3 days ago + i hours): only the per-device cap decides here, never the retention
        await _sql(f"UPDATE desktop_sessions SET ended_at = now() - interval '3 days' + (right(session_key, 1)::int * interval '1 hour') WHERE setup_id = '{sid}'")
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


async def test_01b_a_future_at_is_held_to_now_so_a_stopped_row_still_ages_out(world):
    """2선 (Kadir 5002 ② · PO 04:03Z): `at` = the device's clock. Measured before: 2099 stored as is → a stopped row the 7-day rule
    never reached. Past now + REPORT_CLOCK_SKEW (5 min) it is held down to now — a single report and a snapshot alike; inside the skew
    the device's time stands. Not refused: a 422 state report is retried as is by the daemon (a fast clock would freeze its board)."""
    from app.services import desktop_relay as relay

    assert relay.REPORT_CLOCK_SKEW.total_seconds() == 300
    async with _client() as c:
        d = await _device(c, name="d4554 future at")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        far = "2099-01-01T00:00:00+00:00"
        inside = datetime.fromtimestamp(time.time() + 240, timezone.utc).isoformat()  # 4 min ahead: inside the skew
        r = await c.post("/api/v2/desktop/relay/sessions/f1/state", json=_state(agent, 1, "stopped", at=far), headers=_tok(token))
        assert r.status_code == 200, r.text
        assert (await c.post("/api/v2/desktop/relay/sessions/f2/state", json=_state(agent, 2, "stopped", at=inside), headers=_tok(token))).status_code == 200
        snap = _snap(agent, 3, ["f3"], "stopped")
        snap["sessions"][0]["at"] = far
        snap["sessions"].append({**snap["sessions"][0], "session_key": "f1"})  # f1 again, still in the snapshot
        assert (await c.put(SNAP, json=snap, headers=_tok(token))).status_code == 200
        # seconds ahead of now: (state_at, ended_at) per key
        rows = {k: (state_ahead, end_ahead) for k, state_ahead, end_ahead in await _sql(fetch=(
            f"SELECT session_key, extract(epoch FROM state_at - now()), extract(epoch FROM ended_at - now()) FROM desktop_sessions WHERE setup_id = '{sid}'"))}
        for k in ("f1", "f3"):
            assert rows[k][0] <= 5 and rows[k][1] <= 5, (k, rows[k])  # held to now — not 2099
        assert 200 <= rows["f2"][1] <= 245, rows["f2"]  # 4 min ahead: kept as the device said
        # and so it ages: 8 days back from what was stored → gone with the next report
        await _sql(f"UPDATE desktop_sessions SET ended_at = ended_at - interval '8 days' WHERE setup_id = '{sid}' AND session_key = 'f3'")
        assert (await c.post("/api/v2/desktop/relay/sessions/f2/state", json=_state(agent, 4, "stopped"), headers=_tok(token))).status_code == 200
        assert "f3" not in {r[0] for r in await _rows(sid)}


async def test_04_a_disconnected_device_is_unknown_at_once_its_commands_rejected_its_stream_ended(world, monkeypatch):
    _short_stream(monkeypatch, 6)
    async with _client() as c:
        d = await _device(c, name="d4554 gone")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        assert (await c.put(SNAP, json=_snap(agent, 1, ["s-1"], "waiting_permission"), headers=_tok(token))).status_code == 200
        # Kadir 4981 ②: a permission request the owner's phone answered — its answer_approval is still on its way down
        phone, der = await _register(c)
        await _pair(c, token, der)
        asked = await _post_ask(c, d, _ask(agent))
        assert asked.status_code == 201, asked.text
        rid = asked.json()["id"]
        answered = await c.post(f"/api/v2/agent-permission-requests/{rid}/answer", json=_answer(phone), headers=_person(OWNER))
        assert answered.status_code == 200, answered.text
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
        # the open commands ended rejected · the person's view is unknown now (the revoked token's last heartbeat no longer counts)
        rows = await _sql(fetch=f"SELECT kind, state, result_code FROM desktop_commands WHERE setup_id = '{sid}' ORDER BY device_seq")
        assert [tuple(r) for r in rows] == [("answer_approval", "rejected", "device_disconnected"), ("stop_session", "rejected", "device_disconnected")]
        assert str(cmd.id)  # the stop made above is the second row
        # Kadir 4981 ②: the answer never reached the device — its request is rejected with the same code in the same transaction,
        # never left «answered» (the approver's phone would read a success that was not — mutant: the bulk update alone → RED)
        req = await _sql(fetch=f"SELECT state, result_code FROM agent_permission_requests WHERE id = '{rid}'")
        assert tuple(req[0]) == ("rejected", "device_disconnected")
        view = (await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))).json()["sessions"]
        assert [(v["session_key"], v["state"], v["activity"]) for v in view] == [("s-1", "unknown", "unknown")]


async def test_04b_remote_control_off_takes_the_same_path_an_answered_request_is_rejected_with_its_commands(world):
    """§2.1 off rejected the open commands with its own bulk update — the same false «answered» behind it (Kadir 4981 ②). One path now:
    the answer_approval ends rejected remote_control_off and so does its permission request; a later answer is refused as answered."""
    async with _client() as c:
        d = await _device(c, name="d4554 off")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        assert (await c.put(SNAP, json=_snap(agent, 1, ["s-1"], "waiting_permission"), headers=_tok(token))).status_code == 200
        phone, der = await _register(c)
        await _pair(c, token, der)
        rid = (await _post_ask(c, d, _ask(agent))).json()["id"]
        assert (await c.post(f"/api/v2/agent-permission-requests/{rid}/answer", json=_answer(phone), headers=_person(OWNER))).status_code == 200
        org = (await _sql(fetch=f"SELECT org_id FROM desktop_setups WHERE id = '{sid}'"))[0][0]
        off = await c.put(f"/api/v2/organizations/{org}/remote-control", json={"enabled": False}, headers=_person(OWNER))
        assert off.status_code == 200, off.text
        rows = await _sql(fetch=f"SELECT kind, state, result_code FROM desktop_commands WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [("answer_approval", "rejected", "remote_control_off")]
        req = await _sql(fetch=f"SELECT state, result_code FROM agent_permission_requests WHERE id = '{rid}'")
        assert tuple(req[0]) == ("rejected", "remote_control_off")


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
