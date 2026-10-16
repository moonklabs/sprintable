"""story #4543 (PO 21:12Z) — a person's read of a device's sessions carries when each began and ended (`created_at` · `ended_at`), so
the crew's 7-day ledger reads app coverage over the API alone (`~/.sprintable-shared/minh/4543-ledger.md` D1 · D2).

created_at = the server's first row for the key · ended_at = the device's `at` of a stopped report, or the server's time when a
snapshot dropped the key · null while live (a stopped key reported live again clears it) · both shown for a silent device too (facts,
not the live state)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
from tests.test_4529_desktop_relay_realdb import _device, _remote_control_on, _tok  # noqa: F401 — _remote_control_on: autouse (the relay refuses 409 while off)

pytestmark = pytest.mark.anyio

SNAP = "/api/v2/desktop/relay/sessions"


def _state(agent, seq, state, at: datetime):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": at.isoformat()}


# the device's own clock — times relative to now (no literal timestamp · story #3528/#4079 guards), a few hours back, whole seconds
_BASE = (datetime.now(timezone.utc) - timedelta(hours=3)).replace(microsecond=0)


def _at(minutes: int) -> datetime:
    return _BASE + timedelta(minutes=minutes)


def _ts(v: str | None) -> datetime | None:
    return None if v is None else datetime.fromisoformat(v)


async def _view(c, sid) -> dict[str, dict]:
    r = await c.get(f"/api/v2/desktop/setups/{sid}/sessions", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return {v["session_key"]: v for v in r.json()["sessions"]}


async def test_01_a_persons_read_carries_when_each_session_began_and_ended(world):
    async with _client() as c:
        d = await _device(c, name="d4543 times")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        post = lambda key, seq, state, at: c.post(f"/api/v2/desktop/relay/sessions/{key}/state", json=_state(agent, seq, state, at), headers=_tok(token))  # noqa: E731

        before = datetime.now(timezone.utc) - timedelta(seconds=5)
        assert (await post("s-live", 1, "working", _at(0))).status_code == 200
        assert (await post("s-done", 2, "working", _at(0))).status_code == 200
        assert (await post("s-done", 3, "stopped", _at(90))).status_code == 200
        after = datetime.now(timezone.utc) + timedelta(seconds=5)
        v = await _view(c, sid)
        # a live session: began (the server's first row for the key) · not ended
        assert before <= _ts(v["s-live"]["created_at"]) <= after
        assert v["s-live"]["ended_at"] is None
        # an ended one: ended at the device's `at` of its stopped report
        assert before <= _ts(v["s-done"]["created_at"]) <= after
        assert _ts(v["s-done"]["ended_at"]) == _at(90)
        # the two are the stored columns, not made up for the view
        rows = {r[0]: (r[1], r[2]) for r in await _sql(fetch=f"SELECT session_key, created_at, ended_at FROM desktop_sessions WHERE setup_id = '{sid}'")}
        assert _ts(v["s-done"]["created_at"]) == rows["s-done"][0] and _ts(v["s-done"]["ended_at"]) == rows["s-done"][1]

        # a stopped key reported live again: no longer ended · its beginning unchanged (one row per key)
        began = v["s-done"]["created_at"]
        assert (await post("s-done", 4, "idle", _at(120))).status_code == 200
        v = await _view(c, sid)
        assert v["s-done"]["ended_at"] is None and v["s-done"]["created_at"] == began


async def test_02_a_key_a_snapshot_drops_ends_at_the_servers_time(world):
    async with _client() as c:
        d = await _device(c, name="d4543 snap")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        one = {k: v for k, v in _state(agent, 0, "working", _at(0)).items() if k != "report_seq"}
        assert (await c.put(SNAP, json={"report_seq": 1, "sessions": [{"session_key": "a", **one}, {"session_key": "b", **one}]}, headers=_tok(token))).status_code == 200
        before = datetime.now(timezone.utc) - timedelta(seconds=5)
        assert (await c.put(SNAP, json={"report_seq": 2, "sessions": [{"session_key": "a", **one}]}, headers=_tok(token))).status_code == 200
        after = datetime.now(timezone.utc) + timedelta(seconds=5)
        v = await _view(c, sid)
        assert v["a"]["ended_at"] is None
        assert v["b"]["state"] == "stopped" and before <= _ts(v["b"]["ended_at"]) <= after


async def test_03_a_silent_device_still_shows_the_times(world):
    async with _client() as c:
        d = await _device(c, name="d4543 silent")
        sid, token, agent = d["setup_id"], d["device_token"], d["agents"][0]["member_id"]
        assert (await c.post("/api/v2/desktop/relay/sessions/s-1/state", json=_state(agent, 1, "working", _at(0)), headers=_tok(token))).status_code == 200
        assert (await c.post("/api/v2/desktop/relay/sessions/s-2/state", json=_state(agent, 2, "stopped", _at(10)), headers=_tok(token))).status_code == 200
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '10 minutes' WHERE setup_id = '{sid}'")
        v = await _view(c, sid)
        assert v["s-1"]["state"] == "unknown"  # silent (unchanged)
        assert v["s-1"]["created_at"] and v["s-1"]["ended_at"] is None
        assert _ts(v["s-2"]["ended_at"]) == _at(10)
