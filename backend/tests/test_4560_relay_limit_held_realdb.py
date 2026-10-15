"""story #4560 (contract v2.1 §5 · alembic 0444 · PO 2026-10-07 14:41Z · Yuna `4560-limit-resume-copy.md` §③) — the daemon held off at
a usage limit's end (`limit.held`: the terminal screen was not the expected one · the one Esc it sent was not taken). The server takes
the closed words only, keeps them with the other limit fields, and both readers (the DM header · the device list) carry them."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.desktop_relay import SESSION_LIMIT_HELD
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
from tests.test_4529_desktop_relay_realdb import _device, _tok
from tests.test_4534_desktop_commands_realdb import _remote_control_on  # noqa: F401 — autouse: the org's «원격 제어» on

pytestmark = pytest.mark.anyio
STATE = "/api/v2/desktop/relay/sessions/s-1/state"


def _now():
    return datetime.now(timezone.utc)


def _report(agent, seq, state, **extra):
    return {"report_seq": seq, "agent_member_id": agent, "runtime": "claude", "state": state, "at": _now().isoformat(), **extra}


async def _both(c, agent, setup_id):
    """the DM header's limit and the device list's limit (one session)"""
    v = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))
    assert v.status_code == 200, v.text
    listed = await c.get(f"/api/v2/desktop/setups/{setup_id}/sessions", headers=_person(OWNER))
    [row] = listed.json()["sessions"]
    return v.json()["limit"], row.get("limit")


async def test_the_held_check_is_the_code_list(world):
    """0444's CHECK holds the model's words (one changed alone → RED)."""
    from app.core.database import async_session_factory

    async with async_session_factory() as s:
        (d,) = (await s.execute(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_desktop_sessions_limit_held'"))).one()
    assert set(re.findall(r"'([a-z_]+)'", d)) == set(SESSION_LIMIT_HELD) == {"screen", "esc_not_taken"}


@pytest.mark.parametrize("held", ["screen", "esc_not_taken"])
async def test_a_held_limit_is_kept_and_both_readers_carry_it_until_a_report_without_it(world, held):
    async with _client() as c:
        d = await _device(c, name=f"d4560 held {held}")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]
        passed = (_now() - timedelta(minutes=3)).replace(microsecond=0)
        # PO 14:51Z ②: while held the state stays `paused_limit` — held is the limit's added why
        r = await c.post(STATE, json=_report(agent, 1, "paused_limit", limit={"at": passed.isoformat(), "held": held}), headers=_tok(token))
        assert r.status_code == 200, r.text
        dm, listed = await _both(c, agent, sid)
        assert dm["held"] == held and listed["held"] == held
        assert datetime.fromisoformat(dm["at"]) == passed, "the time it was to lift travels beside it"
        rows = await _sql(fetch=f"SELECT state, limited, limit_held FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [("paused_limit", True, held)]
        # PO 14:51Z ③: the next word without held clears it — still at the limit (a new episode) …
        assert (await c.post(STATE, json=_report(agent, 2, "paused_limit", limit={"at": passed.isoformat()}), headers=_tok(token))).status_code == 200
        dm, listed = await _both(c, agent, sid)
        assert "held" not in dm and "held" not in listed
        rows = await _sql(fetch=f"SELECT limit_held FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [(None,)]
        # … or the limit over: held again, then a word with no limit — stored null, both readers null
        assert (await c.post(STATE, json=_report(agent, 3, "paused_limit", limit={"held": held}), headers=_tok(token))).status_code == 200
        assert (await _both(c, agent, sid)) == ({"held": held}, {"held": held})
        assert (await c.post(STATE, json=_report(agent, 4, "working"), headers=_tok(token))).status_code == 200
        assert (await _both(c, agent, sid)) == (None, None)
        rows = await _sql(fetch=f"SELECT limited, limit_held FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [(None, None)]


async def test_held_comes_with_the_daemons_own_state_word_waiting_input_too(world):
    """PO 14:55Z: the state is the daemon's own (Claude held at its limit reports `waiting_input`) — kept and read the same way."""
    async with _client() as c:
        d = await _device(c, name="d4560 held waiting_input")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]
        passed = (_now() - timedelta(minutes=1)).replace(microsecond=0)
        r = await c.post(STATE, json=_report(agent, 1, "waiting_input", limit={"at": passed.isoformat(), "held": "screen"}), headers=_tok(token))
        assert r.status_code == 200, r.text
        dm, listed = await _both(c, agent, sid)
        assert dm == listed == {"at": passed.isoformat(), "held": "screen"}
        rows = await _sql(fetch=f"SELECT state, limit_held FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [("waiting_input", "screen")]
        v = (await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))).json()
        assert (v["state"], v["activity"]) == ("idle", "waiting_input"), "an older reader still meets one of the five"
        assert (await c.post(STATE, json=_report(agent, 2, "working"), headers=_tok(token))).status_code == 200
        assert (await _both(c, agent, sid)) == (None, None)


async def test_a_snapshot_carries_held_and_a_dropped_session_loses_it(world):
    async with _client() as c:
        d = await _device(c, name="d4560 held snapshot")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]
        snap = {"report_seq": 1, "sessions": [{"session_key": "s-1", "agent_member_id": agent, "runtime": "claude", "state": "paused_limit",
                                               "at": _now().isoformat(), "limit": {"held": "esc_not_taken"}}]}
        assert (await c.put("/api/v2/desktop/relay/sessions", json=snap, headers=_tok(token))).status_code == 200
        assert (await _both(c, agent, sid)) == ({"held": "esc_not_taken"}, {"held": "esc_not_taken"})
        assert (await c.put("/api/v2/desktop/relay/sessions", json={"report_seq": 2, "sessions": []}, headers=_tok(token))).status_code == 200
        rows = await _sql(fetch=f"SELECT state, limit_held FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert [tuple(r) for r in rows] == [("stopped", None)]


async def test_an_unknown_held_word_or_held_on_a_word_that_is_not_a_limit_is_refused(world):
    async with _client() as c:
        d = await _device(c, name="d4560 held refused")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]
        for seq, (state, held) in enumerate([("error", "other"), ("error", ""), ("error", True), ("error", "SCREEN"),
                                             ("error", "screen,esc_not_taken"), ("working", "screen"), ("idle", "screen"),
                                             ("waiting_permission", "esc_not_taken")], start=1):
            r = await c.post(STATE, json=_report(agent, seq, state, limit={"held": held}), headers=_tok(token))
            assert r.status_code == 422, (state, held, r.text)
        rows = await _sql(fetch=f"SELECT count(*) FROM desktop_sessions WHERE setup_id = '{sid}'")
        assert rows[0][0] == 0, "nothing written by a refused report"


async def test_held_is_not_said_for_a_device_not_heard(world):
    """the readers' rule for every limit field (§3 unknown): a device silent past UNKNOWN_AFTER says nothing about its limit."""
    async with _client() as c:
        d = await _device(c, name="d4560 held silent")
        token, agent, sid = d["device_token"], d["agents"][0]["member_id"], d["setup_id"]
        assert (await c.post(STATE, json=_report(agent, 1, "error", limit={"held": "screen"}), headers=_tok(token))).status_code == 200
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '5 minutes' WHERE setup_id = '{sid}'")
        assert (await _both(c, agent, sid)) == (None, None)
