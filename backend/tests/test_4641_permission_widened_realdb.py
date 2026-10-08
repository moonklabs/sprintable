"""story #4641 (design 4641 · lens ②) — the widening on the session, through the real reader: the three keys reach a heard device's
session, and a silent device's session carries none (the gate in device_sessions_view, not only the helper).
Needs the migrated database (realdb) — CI runs it; the pure rules are in test_4641_permission_widened_unit.py."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import text

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
from tests.test_4529_desktop_relay_realdb import _device, _remote_control_on, _tok  # noqa: F401 — _remote_control_on is autouse there

STATE = "/api/v2/desktop/relay/sessions/s-1/state"


def _now():
    return datetime.now(timezone.utc)


async def _view(c, agent):
    r = await c.get(f"/api/v2/agents/{agent}/desktop-session", headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return r.json()


async def test_01_a_widening_reaches_a_heard_device_and_a_silent_one_gets_no_keys(world):
    async with _client() as c:
        d = await _device(c, name="d4641 widen c")
        token, agent = d["device_token"], d["agents"][0]["member_id"]
        at = _now().isoformat()
        body = {
            "report_seq": 1, "agent_member_id": agent, "runtime": "claude", "state": "working", "at": at,
            "permission_widened_at": at, "permission_widened_from": "plan", "permission_widened_to": "auto",
        }
        assert (await c.post(STATE, json=body, headers=_tok(token))).status_code == 200
        v = await _view(c, agent)
        assert (v["permission_widened_from"], v["permission_widened_to"]) == ("plan", "auto")
        assert v["permission_widened_at"]
        # the device goes quiet (its last heard long ago): the stored widening is not said
        await _sql(f"UPDATE desktop_device_tokens SET last_used_at = now() - interval '1 day' WHERE setup_id = '{d['setup_id']}'")
        v = await _view(c, agent)
        assert "permission_widened_at" not in v and "permission_widened_to" not in v
