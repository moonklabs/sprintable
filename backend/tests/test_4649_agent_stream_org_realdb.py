"""story 4649 — the daemon's stream is `GET /api/v2/agent/stream` (agent_gateway), and its frames lead with `stream_org_id` and
`sender_org_id` on BOTH the backfill and the live path. The events-stream change (`/api/v2/events/stream`) never reached this
route; this file pins the route the daemon actually dials, through the real `agent_stream()` generator and a real DB.

- backfill: an event from a sender in ANOTHER org, dispatched before the stream opens → its frame names the stream's org (the
  authenticated one) and the sender's own org, both first in the frame; a forged `stream_org_id` / `sender_org_id` in the payload
  is replaced by the server's values.
- live: the same, for a frame that arrives while the stream is connected (the wake path).
- one batch → one members lookup (not per row).
- removing the builder (`_with_stream_org`) from the agent stream turns these RED.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest

from tests.test_2381_ac4_live_wake_delivery_realdb import (
    _FakeRequest,
    _open_stream,
    _patch_side_effects,
    _session_factory,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(Session):
    """an agent in org A, and two senders: one in org B (a cross-org write) and one in org C."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org_a, org_b, org_c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    project_a, project_b = uuid.uuid4(), uuid.uuid4()
    agent_id, sender_b, sender_c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        for org in (org_a, org_b, org_c):
            s.add(Organization(id=org, name="t", slug=f"t-{org}", plan="free"))
        await s.flush()
        s.add(Project(id=project_a, org_id=org_a, name="pa"))
        s.add(Project(id=project_b, org_id=org_b, name="pb"))
        await s.flush()
        s.add(TeamMember(id=agent_id, org_id=org_a, project_id=project_a, type="agent", name="agent", role="member",
                         is_active=True, runtime_type="claude-code"))
        s.add(TeamMember(id=sender_b, org_id=org_b, project_id=project_b, type="human", name="sb", role="member", is_active=True))
        s.add(TeamMember(id=sender_c, org_id=org_c, project_id=project_b, type="human", name="sc", role="member", is_active=True))
        await s.commit()
    return {"org_a": org_a, "org_b": org_b, "org_c": org_c, "project_a": project_a, "agent": agent_id,
            "sender_b": sender_b, "sender_c": sender_c}


async def _dispatch(Session, ids, *, sender_id: uuid.UUID, payload: dict) -> None:
    """a real dispatch: Event → assign_recipient_seq (the agent's visibility gate) → commit, in the agent's org."""
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    async with Session() as s:
        event = Event(
            project_id=ids["project_a"], org_id=ids["org_a"], event_type="dispatched",
            recipient_id=ids["agent"], recipient_type="agent", sender_id=sender_id,
            payload=payload, status="pending",
        )
        s.add(event)
        await s.flush()
        await assign_recipient_seq(s, event)
        await s.commit()


async def _next_event_frame(agen, timeout: float = 5.0) -> dict:
    """the next data frame of an event (heartbeats skipped), as its parsed JSON. `asyncio.wait` — not wait_for — so a timeout
    leaves the stream alone and fails here instead of being swallowed by the generator's cancel handling."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        task = asyncio.create_task(agen.__anext__())
        done, _ = await asyncio.wait({task}, timeout=max(0.01, deadline - loop.time()))
        assert task in done, "no event frame came in time"
        frame = task.result()
        if frame.startswith("event: heartbeat"):
            continue
        data_line = next(line for line in frame.splitlines() if line.startswith("data: "))
        return json.loads(data_line[len("data: "):])


def _assert_leading_org_keys(frame: dict, *, stream_org: uuid.UUID, sender_org: uuid.UUID) -> None:
    assert list(frame)[:2] == ["stream_org_id", "sender_org_id"], f"the two org keys lead the frame — got {list(frame)[:4]}"
    assert frame["stream_org_id"] == str(stream_org), "the stream's org is the authenticated one"
    assert frame["sender_org_id"] == str(sender_org), "the sender's own org, from the server — not the payload's"


@pytest.mark.anyio
async def test_backfill_frame_on_the_daemon_route_names_both_orgs_and_ignores_forged_payload(monkeypatch):
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ids = await _seed(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())
        # the sender is in org B, the event is in the agent's org A (a write path let a cross-org sender through) — and the
        # payload forges both org keys
        forged = str(uuid.uuid4())
        await _dispatch(Session, ids, sender_id=ids["sender_b"],
                        payload={"content": "hi", "stream_org_id": forged, "sender_org_id": forged})

        resp = await _open_stream(ag, Session, ids["agent"], ids["org_a"])
        agen = resp.body_iterator
        try:
            frame = await _next_event_frame(agen)
            _assert_leading_org_keys(frame, stream_org=ids["org_a"], sender_org=ids["org_b"])
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(ids["agent"]), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
async def test_live_frame_on_the_daemon_route_names_both_orgs(monkeypatch):
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ids = await _seed(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())

        resp = await _open_stream(ag, Session, ids["agent"], ids["org_a"])
        agen = resp.body_iterator
        try:
            first = await agen.__anext__()
            assert "event: heartbeat" in first
            # the frame comes while the stream is connected (after its backfill, in the wait) — the wake path
            next_frame = asyncio.create_task(_next_event_frame(agen))
            await asyncio.sleep(0.05)
            await _dispatch(Session, ids, sender_id=ids["sender_c"], payload={"content": "live"})
            frame = await asyncio.wait_for(next_frame, timeout=5.0)
            _assert_leading_org_keys(frame, stream_org=ids["org_a"], sender_org=ids["org_c"])
            assert frame["is_backfill"] is False
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(ids["agent"]), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
async def test_backfill_batch_looks_up_its_senders_once(monkeypatch):
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ids = await _seed(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())
        for sender in (ids["sender_b"], ids["sender_c"], ids["sender_b"]):
            await _dispatch(Session, ids, sender_id=sender, payload={"content": "x"})

        calls: list[int] = []
        real_lookup = ag.lookup_members_by_ids

        async def counting_lookup(member_ids, session):
            calls.append(len(member_ids))
            return await real_lookup(member_ids, session)

        monkeypatch.setattr(ag, "lookup_members_by_ids", counting_lookup)
        resp = await _open_stream(ag, Session, ids["agent"], ids["org_a"])
        agen = resp.body_iterator
        try:
            await _next_event_frame(agen)  # the first backfill frame — its batch is done by now
            assert calls == [2], f"one lookup for the whole batch, over its two distinct senders — got {calls}"
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(ids["agent"]), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
async def test_live_direct_push_frame_overwrites_forged_org_keys_with_server_values(monkeypatch):
    """the direct push (no recipient_seq — the legacy path) carries whatever its payload says: a forged stream_org_id and
    sender_org_id must not reach the daemon — the stream's org is the authenticated one, the sender's is the server's."""
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ids = await _seed(Session)
        monkeypatch.setattr(ag, "async_session_factory", lambda: Session())

        resp = await _open_stream(ag, Session, ids["agent"], ids["org_a"])
        agen = resp.body_iterator
        try:
            first = await agen.__anext__()
            assert "event: heartbeat" in first
            next_frame = asyncio.create_task(_next_event_frame(agen))
            await asyncio.sleep(0.05)
            forged = str(uuid.uuid4())
            ag._push_to_agent_v2(str(ids["agent"]), {
                "event_type": "message", "sender_id": str(ids["sender_b"]), "content": "live",
                "stream_org_id": forged, "sender_org_id": forged,
            })
            frame = await asyncio.wait_for(next_frame, timeout=5.0)
            _assert_leading_org_keys(frame, stream_org=ids["org_a"], sender_org=ids["org_b"])
            assert frame["is_backfill"] is False
        finally:
            await agen.aclose()
    finally:
        ag._agent_connections.pop(str(ids["agent"]), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


async def _seed_http_key(Session, agent_id: uuid.UUID) -> str:
    """a real agent key: the raw `sk_live_…` string goes to the client, its hash is what the row keeps (as issuance does)."""
    from app.core.security import hash_token
    from app.models.api_key import ApiKey

    raw = "sk_live_" + uuid.uuid4().hex
    async with Session() as s:
        s.add(ApiKey(id=uuid.uuid4(), team_member_id=agent_id, key_prefix=raw[:12], key_hash=hash_token(raw)))
        await s.commit()
    return raw


async def _stream_over_http(raw_key: str, want) -> dict:
    """GET /api/v2/agent/stream through the real ASGI app — routing, DI and the key's own check all run. The body never ends,
    so the request is disconnected once the frame `want` accepts has come. Returns that frame's parsed JSON."""
    from app.main import app

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
        "path": "/api/v2/agent/stream", "raw_path": b"/api/v2/agent/stream", "query_string": b"", "root_path": "",
        "headers": [(b"x-agent-api-key", raw_key.encode()), (b"accept", b"text/event-stream")],
        "client": ("127.0.0.1", 50000), "server": ("test", 80),
    }
    sent: asyncio.Queue = asyncio.Queue()
    requested = False
    disconnect = asyncio.Event()

    async def receive():
        nonlocal requested
        if not requested:
            requested = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        await sent.put(message)

    task = asyncio.create_task(app(scope, receive, send))
    try:
        start = await asyncio.wait_for(sent.get(), timeout=10.0)
        assert start["type"] == "http.response.start"
        assert start["status"] == 200, f"the stream route refused the key: {start}"
        buf = b""
        while True:
            msg = await asyncio.wait_for(sent.get(), timeout=10.0)
            buf += msg.get("body", b"")
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                text_block = block.decode("utf-8")
                if text_block.startswith("event: heartbeat") or not text_block.strip():
                    continue
                data_line = next(line for line in text_block.splitlines() if line.startswith("data: "))
                frame = json.loads(data_line[len("data: "):])
                if want(frame):
                    return frame
    finally:
        disconnect.set()
        try:
            await asyncio.wait_for(task, timeout=10.0)
        except asyncio.TimeoutError:
            task.cancel()


@pytest.mark.anyio
async def test_http_agent_stream_route_frame_names_both_orgs_with_a_forged_payload(monkeypatch):
    """the daemon's own door: GET /api/v2/agent/stream with the agent's key header, through the real app — the backfill frame
    of a cross-org sender whose payload forges both keys comes out with the server's values, leading the frame."""
    import app.routers.agent_gateway as ag

    _patch_side_effects(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ids = await _seed(Session)
        forged = str(uuid.uuid4())
        await _dispatch(Session, ids, sender_id=ids["sender_b"],
                        payload={"content": "hi", "stream_org_id": forged, "sender_org_id": forged})
        raw_key = await _seed_http_key(Session, ids["agent"])

        frame = await _stream_over_http(raw_key, want=lambda f: f.get("event_type") == "dispatched")
        _assert_leading_org_keys(frame, stream_org=ids["org_a"], sender_org=ids["org_b"])
        assert frame["is_backfill"] is True
    finally:
        ag._agent_connections.pop(str(ids["agent"]), None)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()
