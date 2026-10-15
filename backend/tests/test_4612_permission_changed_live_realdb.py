"""story #4612 (PO 23:36Z · after 4607): a permission request's LATER change — answered · withdrawn (4 reasons) · rejected by the daemon ·
back to pending for its second answer — is told to the one person whose list shows it, after the commit, as a transient SSE frame
`agent.permission_request.changed` carrying only {request_id, state} (no Event row · no summary · tool · folder). A refused change
(nothing moved · a rolled-back request) tells nothing. Before: no notice at all, so a card left open on another screen waited for its
next 15 s read."""
from __future__ import annotations

import asyncio
import uuid
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
from tests.test_4529_desktop_relay_realdb import _device, _remote_control_on, _tok  # noqa: F401 — _remote_control_on: autouse
from tests.test_4533_agent_permissions_realdb import _answer, _ask, _pair, _post_ask, _register, _with_session  # noqa: F401

pytestmark = pytest.mark.anyio

REQS = "/api/v2/agent-permission-requests"
CHANGED = "agent.permission_request.changed"


@pytest.fixture
def pushed(monkeypatch):
    """every live push, (member, payload) — the changes are picked out by event_type (other flows push their own frames)"""
    import app.routers.events as events_mod

    got: list[tuple[str, dict]] = []
    monkeypatch.setattr(events_mod, "_push_to_agent", lambda mid, payload, _from_listener=False: got.append((mid, dict(payload))) or True)
    return got


def changes(pushed) -> list[tuple[str, dict]]:
    return [(m, p) for m, p in pushed if p.get("event_type") == CHANGED]


async def _ready(c, name):
    d = await _device(c, name=name)
    agent = await _with_session(c, d)
    phone_id, der = await _register(c)
    await _pair(c, d["device_token"], der)
    return d, agent, phone_id


async def _new(c, d, agent, **extra):
    body = _ask(agent, **extra)
    r = await _post_ask(c, d, body)
    assert r.status_code == 201, r.text
    row_id = r.json()["id"]
    recipient = str((await _sql(fetch=f"SELECT recipient_member_id FROM agent_permission_requests WHERE id = '{row_id}'"))[0][0])
    return body["request_id"], row_id, recipient


async def test_01_answer_tells_the_recipient_only_with_request_id_and_state(world, pushed):
    async with _client() as c:
        d, agent, phone_id = await _ready(c, "d4612 answer")
        rid, row_id, recipient = await _new(c, d, agent)
        before = len(changes(pushed))
        r = await c.post(f"{REQS}/{row_id}/answer", json=_answer(phone_id), headers=_person(OWNER))
        assert r.status_code == 200, r.text
        got = changes(pushed)[before:]
        assert got == [(recipient, {"event_type": CHANGED, "request_id": rid, "state": "answered"})]
        assert recipient != agent
        # no Event row for it (nothing for the bell) — only the new request's own notice exists
        n = await _sql(fetch=f"SELECT count(*) FROM events WHERE source_entity_id = '{row_id}'")
        assert n[0][0] == 1
        # answered again → 409 · nothing moved · nothing told (the rolled-back request schedules nothing)
        twice = await c.post(f"{REQS}/{row_id}/answer", json=_answer(phone_id, "deny"), headers=_person(OWNER))
        assert twice.status_code == 409
        assert changes(pushed)[before:] == got


@pytest.mark.parametrize("reason", ["answered_locally", "session_ended", "expired"])
async def test_02_withdraw_tells_once_and_a_second_withdraw_tells_nothing(world, pushed, reason):
    async with _client() as c:
        d, agent, _ = await _ready(c, f"d4612 w {reason}")
        rid, _row_id, recipient = await _new(c, d, agent)
        url = f"/api/v2/desktop/relay/permission-requests/{rid}/withdraw"
        assert (await c.post(url, json={"reason": reason}, headers=_tok(d["device_token"]))).status_code == 200
        assert changes(pushed) == [(recipient, {"event_type": CHANGED, "request_id": rid, "state": "withdrawn"})]
        # already withdrawn: nothing moves → nothing told
        assert (await c.post(url, json={"reason": reason}, headers=_tok(d["device_token"]))).status_code == 200
        assert len(changes(pushed)) == 1


async def _net_answered_allow(c, d, agent, phone_id):
    """a Claude network question answered «allow…» at its first stage (the shape F2 and the second answer start from)"""
    rid, row_id, recipient = await _new(c, d, agent, tool="SandboxNetwork")
    r = await c.post(f"{REQS}/{row_id}/answer", json=_answer(phone_id), headers=_person(OWNER))
    assert r.status_code == 200, r.text
    return rid, row_id, recipient


async def test_03_withdraw_host_unread_tells_once(world, pushed):
    async with _client() as c:
        d, agent, phone_id = await _ready(c, "d4612 f2")
        rid, _row_id, recipient = await _net_answered_allow(c, d, agent, phone_id)
        before = len(changes(pushed))
        r = await c.post(f"/api/v2/desktop/relay/permission-requests/{rid}/withdraw", json={"reason": "host_unread"}, headers=_tok(d["device_token"]))
        assert r.status_code == 200, r.text
        assert changes(pushed)[before:] == [(recipient, {"event_type": CHANGED, "request_id": rid, "state": "withdrawn"})]


async def test_04_the_daemons_rejection_tells_once_a_done_tells_nothing(world, pushed):
    async with _client() as c:
        d, agent, phone_id = await _ready(c, "d4612 reject")
        rid, row_id, recipient = await _new(c, d, agent)
        assert (await c.post(f"{REQS}/{row_id}/answer", json=_answer(phone_id), headers=_person(OWNER))).status_code == 200
        before = len(changes(pushed))
        cid = (await _sql(fetch=f"SELECT id FROM desktop_commands WHERE setup_id = '{d['setup_id']}' AND kind = 'answer_approval'"))[0][0]
        r = await c.post(f"/api/v2/desktop/relay/commands/{cid}/result", json={"state": "rejected", "result_code": "bad_signature"},
                         headers=_tok(d["device_token"]))
        assert r.status_code == 200, r.text
        assert changes(pushed)[before:] == [(recipient, {"event_type": CHANGED, "request_id": rid, "state": "rejected"})]

        # another request answered and then «done»: the row stays answered → nothing told
        rid2, row2, _ = await _new(c, d, agent)
        assert (await c.post(f"{REQS}/{row2}/answer", json=_answer(phone_id), headers=_person(OWNER))).status_code == 200
        before = len(changes(pushed))
        cid2 = (await _sql(fetch=f"SELECT id FROM desktop_commands WHERE setup_id = '{d['setup_id']}' AND payload->>'request_id' = '{rid2}'"))[0][0]
        assert (await c.post(f"/api/v2/desktop/relay/commands/{cid2}/result", json={"state": "done"}, headers=_tok(d["device_token"]))).status_code == 200
        assert changes(pushed)[before:] == []


async def test_05_the_second_answer_back_to_pending_tells_once(world, pushed):
    async with _client() as c:
        d, agent, phone_id = await _ready(c, "d4612 confirm")
        rid, _row_id, recipient = await _net_answered_allow(c, d, agent, phone_id)
        before = len(changes(pushed))
        body = {"host": "gitlab.com", "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()}
        url = f"/api/v2/desktop/relay/permission-requests/{rid}/confirm-host"
        r = await c.post(url, json=body, headers=_tok(d["device_token"]))
        assert r.status_code == 200, r.text
        assert changes(pushed)[before:] == [(recipient, {"event_type": CHANGED, "request_id": rid, "state": "pending"})]
        # the same report again: the same row, nothing moved → nothing told
        assert (await c.post(url, json=body, headers=_tok(d["device_token"]))).status_code == 200
        assert len(changes(pushed)[before:]) == 1


async def test_06_the_real_push_is_a_transient_frame_on_the_recipients_open_stream(world):
    """no stand-in for _push_to_agent: the recipient's real queue gets one frame with no Event id (the transient path: its own id ·
    the reconnect replay) and only the three keys + the transient id the stream swaps for an id."""
    from app.routers.events import _agent_connections

    async with _client() as c:
        d, agent, phone_id = await _ready(c, "d4612 real")
        _rid0, _row0, recipient = await _new(c, d, agent)
        rid, row_id, _ = await _new(c, d, agent)
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        _agent_connections.setdefault(recipient, set()).add(q)
        try:
            assert (await c.post(f"{REQS}/{row_id}/answer", json=_answer(phone_id), headers=_person(OWNER))).status_code == 200
            frames = [q.get_nowait() for _ in range(q.qsize())]
        finally:
            _agent_connections.get(recipient, set()).discard(q)
            if not _agent_connections.get(recipient):
                _agent_connections.pop(recipient, None)
        mine = [f for f in frames if f.get("event_type") == CHANGED]
        assert len(mine) == 1, frames
        f = mine[0]
        assert "event_id" not in f and set(f) == {"event_type", "request_id", "state", "_sse_transient_id"}
        assert (f["request_id"], f["state"]) == (rid, "answered")
