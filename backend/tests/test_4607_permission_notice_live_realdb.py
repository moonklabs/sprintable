"""story #4607 (PO 22:42Z · measured on dev: question → phone card 0.76 s / 9.1 s — the approvals page's 15 s poll, never its «new request
→ read now»): a new permission request's notice reaches the recipient's OPEN event stream at once. dispatch_notification only INSERTs a
person's Event (dispatched · payload.event_type = agent.permission_request); the router now pushes it after the commit, in the backfill
frame's shape (one event_id → the client's dedup holds across a live frame and a later backfill)."""
from __future__ import annotations

import asyncio
import uuid

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
from tests.test_4533_agent_permissions_realdb import _ask, _pair, _post_ask, _register, _with_session  # noqa: F401

pytestmark = pytest.mark.anyio


async def _recipient(request_row_id: str) -> str:
    rows = await _sql(fetch=f"SELECT recipient_member_id FROM agent_permission_requests WHERE id = '{request_row_id}'")
    return str(rows[0][0])


async def test_01_a_new_request_reaches_the_recipients_open_stream_at_once(world, monkeypatch):
    from app.routers.events import _agent_connections
    from app.services import event_broker as broker_mod

    # PO 22:46Z ③: another instance's stream gets it through the broker (PG NOTIFY) — the SAME payload as the local queue
    published: list[tuple[str, str, str, dict]] = []

    async def capture(kind, member_id, event_type, payload):
        published.append((kind, member_id, event_type, payload))

    monkeypatch.setattr(broker_mod.event_broker, "publish", capture)
    async with _client() as c:
        d = await _device(c, name="d4607 live")
        token = d["device_token"]
        agent = await _with_session(c, d)
        _, der = await _register(c)
        await _pair(c, token, der)
        # the first request tells who receives (the paired phone's owner) — then that person's stream is open for the second
        first = await _post_ask(c, d, _ask(agent))
        assert first.status_code == 201, first.text
        recipient = await _recipient(first.json()["id"])
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        _agent_connections.setdefault(recipient, set()).add(q)
        try:
            second = await _post_ask(c, d, _ask(agent))
            assert second.status_code == 201, second.text
            frames = [q.get_nowait() for _ in range(q.qsize())]
        finally:
            _agent_connections.get(recipient, set()).discard(q)
            if not _agent_connections.get(recipient):
                _agent_connections.pop(recipient, None)
        notices = [f for f in frames if f.get("event_type") == "dispatched" and (f.get("payload") or {}).get("event_type") == "agent.permission_request"]
        assert len(notices) == 1, frames
        n = notices[0]
        # it is the committed row's own Event (the client dedups a later backfill of it by this id) · it points at this request
        ev = await _sql(fetch=f"SELECT id, recipient_id FROM events WHERE id = '{n['event_id']}'")
        assert ev and str(ev[0][1]) == recipient
        assert n["source"] == {"type": "agent_permission_request", "id": second.json()["id"]}
        assert n.get("is_backfill") is None  # the live loop adds it — the queued frame is the backfill frame's data
        await asyncio.sleep(0)  # fire_and_forget's task runs
        mine = [p for p in published if (p[3].get("payload") or {}).get("event_type") == "agent.permission_request" and p[3].get("event_id") == n["event_id"]]
        assert len(mine) == 1, published
        assert mine[0][:3] == ("agent", recipient, "dispatched") and mine[0][3] == n


async def test_02_the_same_request_again_pushes_nothing_more(world, monkeypatch):
    import app.routers.events as events_mod

    pushed: list[tuple[str, dict]] = []
    monkeypatch.setattr(events_mod, "_push_to_agent", lambda mid, payload, _from_listener=False: pushed.append((mid, payload)) or True)
    # other flows (the device's setup · its session reports) push their own frames — only this notice's are counted
    notices = lambda: [p for _, p in pushed if (p.get("payload") or {}).get("event_type") == "agent.permission_request"]  # noqa: E731
    async with _client() as c:
        d = await _device(c, name="d4607 once")
        token = d["device_token"]
        agent = await _with_session(c, d)
        _, der = await _register(c)
        await _pair(c, token, der)
        body = _ask(agent, request_id=uuid.uuid4())
        first = await _post_ask(c, d, body)
        assert first.status_code == 201
        assert len(notices()) == 1
        # PO 22:46Z ②: only the request's own person recipient — no other member of the org, no agent
        recipient = await _recipient(first.json()["id"])
        assert {mid for mid, p in pushed if (p.get("payload") or {}).get("event_type") == "agent.permission_request"} == {recipient}
        assert recipient != agent
        # the same request_id again: the row is found, nothing new is sent (200 · no second notice · no second push)
        again = await _post_ask(c, d, body)
        assert again.status_code == 200, again.text
        assert len(notices()) == 1


async def test_02b_a_refused_request_pushes_nothing(world, monkeypatch):
    """PO 22:46Z ①: a request the server refuses (rolled back — here: a session the device never reported) never reaches a phone."""
    import app.routers.events as events_mod

    pushed: list[dict] = []
    monkeypatch.setattr(events_mod, "_push_to_agent", lambda mid, payload, _from_listener=False: pushed.append(payload) or True)
    async with _client() as c:
        d = await _device(c, name="d4607 refused")
        token = d["device_token"]
        agent = await _with_session(c, d)
        _, der = await _register(c)
        await _pair(c, token, der)
        r = await _post_ask(c, d, _ask(agent, session_key="s-never-reported"))
        assert r.status_code == 422, r.text
        assert [p for p in pushed if (p.get("payload") or {}).get("event_type") == "agent.permission_request"] == []
        rows = await _sql(fetch="SELECT count(*) FROM events WHERE source_entity_type = 'agent_permission_request'")
        assert rows[0][0] == 0  # nothing committed either


async def test_03_a_failed_push_leaves_the_201(world, monkeypatch):
    import app.routers.events as events_mod

    def boom(*_a, **_k):
        raise RuntimeError("queue gone")

    monkeypatch.setattr(events_mod, "_push_to_agent", boom)
    async with _client() as c:
        d = await _device(c, name="d4607 boom")
        token = d["device_token"]
        agent = await _with_session(c, d)
        _, der = await _register(c)
        await _pair(c, token, der)
        r = await _post_ask(c, d, _ask(agent))
        assert r.status_code == 201, r.text
        # the notice row is committed all the same (the poll and the next backfill still bring it)
        rows = await _sql(fetch=f"SELECT count(*) FROM events WHERE source_entity_id = '{r.json()['id']}' AND event_type = 'dispatched'")
        assert rows[0][0] >= 1
