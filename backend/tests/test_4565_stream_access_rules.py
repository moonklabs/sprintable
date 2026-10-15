"""story #4565 (Qadir 4961 qa:pass note · PO 06:08Z) — the shared open-connection key recheck (services/stream_access.py) and its
three rules, pinned where they live and on each connection that uses them:

1. a key id that is not a UUID closes («key_revoked») — the DB is not asked (fail closed: an auth path with no id never slips by)
2. a DB error or a DB timeout skips that one check (None) with a log line — the recheck must not drop connections while the DB is
   unwell
3. any other error propagates — a bug in the check never leaves every connection quietly open

…and /events/stream · the A2A streaming reply · /ws/chat each act on the same verdict (revoked → the connection ends · DB error →
it goes on). No behaviour changes here — tests only (no DB: the check's DB step is replaced where a case needs it)."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import OperationalError, SQLAlchemyError

from app.services import stream_access as sa


@pytest.fixture
def anyio_backend():
    return "asyncio"


MEMBER = uuid.UUID("d4565000-0000-0000-0000-0000000000f1")


# ── 1 · 2 · 3: the function itself ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
@pytest.mark.parametrize("key_id", ["test-key", "", None, 7, "sk_live_x", "1234"])
async def test_a_key_id_that_is_not_a_uuid_closes_without_asking_the_db(key_id):
    asked = AsyncMock(return_value=None)
    assert await sa.key_access_revoked(key_id, MEMBER, db_check=asked) == "key_revoked"
    asked.assert_not_called()


@pytest.mark.anyio
# Qadir 4963 ③: the base class itself and TimeoutError each (a subclass alone would let «OperationalError only» pass)
@pytest.mark.parametrize("error", [SQLAlchemyError("db down"), OperationalError("SELECT 1", {}, Exception("server closed the connection")), TimeoutError("pool")])
async def test_a_db_error_or_timeout_skips_that_one_check_with_a_log_line(error, caplog):
    caplog.set_level(logging.WARNING, logger="app.services.stream_access")
    failing = AsyncMock(side_effect=error)
    assert await sa.key_access_revoked(str(uuid.uuid4()), MEMBER, db_check=failing) is None
    assert any("stream access recheck failed" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_any_other_error_propagates():
    broken = AsyncMock(side_effect=ValueError("a bug in the check"))
    with pytest.raises(ValueError):
        await sa.key_access_revoked(str(uuid.uuid4()), MEMBER, db_check=broken)


@pytest.mark.anyio
async def test_the_db_step_answers_when_asked_and_its_answer_is_the_verdict():
    for answer in ("key_revoked", "member_inactive", None):
        step = AsyncMock(return_value=answer)
        assert await sa.key_access_revoked(str(uuid.uuid4()), MEMBER, db_check=step) == answer
        step.assert_awaited_once()


@pytest.mark.anyio
async def test_access_recheck_asks_only_when_due():
    calls = []

    async def step(key_uuid, member_id, *, agent_only=True):
        calls.append(member_id)
        return None

    with patch.object(sa, "key_access_revoked_db", step):
        r = sa.AccessRecheck(str(uuid.uuid4()), MEMBER)
        assert await r.due(60) is None and calls == []  # the connect check counts as the first one
        assert await r.due(0) is None and calls == [MEMBER]


# ── each connection acts on the same verdict ───────────────────────────────────────────────────────────────────────────

def _verdict(kind: str):
    """The check's DB step for a case: «revoked» answers key_revoked · «db_error» raises a DB error (skipped · logged)."""
    async def step(key_uuid, member_id, *, agent_only=True):
        if kind == "revoked":
            return "key_revoked"
        raise SQLAlchemyError("db down")
    return step


class _Request:
    headers: dict = {}

    async def is_disconnected(self) -> bool:
        return False


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["revoked", "db_error"])
async def test_events_stream_acts_on_the_verdict(kind, caplog):
    import app.routers.events as ev

    caplog.set_level(logging.WARNING, logger="app.services.stream_access")
    member = uuid.uuid4()
    session = AsyncMock()
    membership = MagicMock(); membership.scalar_one_or_none.return_value = member
    pending = MagicMock(); pending.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(side_effect=[membership, pending])

    @asynccontextmanager
    async def factory():
        yield session

    auth = MagicMock(); auth.user_id = str(member)
    auth.claims = {"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4())}}
    frames: list[str] = []
    try:
        with patch("app.core.database.async_session_factory", factory), patch.object(sa, "key_access_revoked_db", _verdict(kind)), \
             patch.object(ev, "_SSE_HEARTBEAT_TIMEOUT", 0.02), patch("app.services.sse_lease.refresh", AsyncMock()):
            resp = await ev.agent_event_stream(request=_Request(), member_id=None, auth=auth, org_id=uuid.uuid4(), since_timestamp=None, last_event_id=None)
            agen = resp.body_iterator
            ended = False
            for _ in range(6):
                try:
                    frames.append(await asyncio.wait_for(agen.__anext__(), 2))
                except StopAsyncIteration:
                    ended = True
                    break
            await agen.aclose()
    finally:
        ev._agent_connections.pop(str(member), None)
        from app.core import shutdown
        shutdown.reset_shutdown_event()
    revoked = [f for f in frames if f.startswith("event: access_revoked")]
    if kind == "revoked":
        assert revoked and json.loads(revoked[0].split("data: ", 1)[1]) == {"reason": "key_revoked"}, frames
        # Qadir 4963 ②: the stream ENDS there — nothing after it
        assert ended and frames[-1] is revoked[0], frames
    else:
        assert not revoked and sum("heartbeat" in f for f in frames) >= 3, frames  # it went on
        assert any("stream access recheck failed" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_a2a_route_hands_the_callers_key_to_the_stream_check():
    """Qadir 4963 ①: through the route (a2a_rpc) — the caller's key id reaches the stream's recheck; a route that dropped it
    would stream on (here the recheck says revoked, so the stream must end with the error frame)."""
    import app.routers.a2a as a2a

    task_id = str(uuid.uuid4())
    sent = {"task": {"id": task_id, "contextId": "c", "status": {"state": "working"}}}

    def poll_factory():
        raise AssertionError("streamed on past the recheck — the route did not hand the caller's key over")

    auth = MagicMock()
    auth.claims = {"app_metadata": {"api_key_id": str(uuid.uuid4())}}
    body = a2a.JsonRpcRequest(jsonrpc="2.0", id=1, method="SendStreamingMessage", params={})
    with patch.object(a2a, "_get_agent_member", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4()))), \
         patch.object(a2a, "_handle_send_message", AsyncMock(return_value=sent)), patch.object(a2a, "RECHECK_BEFORE_SEND_SEC", 0), \
         patch.object(a2a, "async_session_factory", poll_factory), patch.object(sa, "key_access_revoked_db", _verdict("revoked")):
        resp = await a2a.a2a_rpc(_Request(), uuid.uuid4(), body, org_id=uuid.uuid4(), auth=auth, session=AsyncMock())
        agen = resp.body_iterator
        assert task_id in await agen.__anext__()
        assert "access revoked: key_revoked" in await agen.__anext__()
        with pytest.raises(StopAsyncIteration):
            await agen.__anext__()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["revoked", "db_error"])
async def test_a2a_streaming_reply_acts_on_the_verdict(kind):
    import app.routers.a2a as a2a

    task_id = str(uuid.uuid4())
    sent = {"task": {"id": task_id, "contextId": "c", "status": {"state": "working"}}}

    class _PastTheCheck(Exception):
        """the stream went on past the recheck (it reached its own DB poll)"""

    def poll_factory():
        raise _PastTheCheck()

    session = AsyncMock()
    member = SimpleNamespace(id=uuid.uuid4())
    with patch.object(a2a, "_handle_send_message", AsyncMock(return_value=sent)), patch.object(a2a, "RECHECK_BEFORE_SEND_SEC", 0), \
         patch.object(a2a, "async_session_factory", poll_factory), patch.object(sa, "key_access_revoked_db", _verdict(kind)):
        resp = await a2a._stream_send_message(_Request(), 1, session, member, uuid.uuid4(), {}, frozenset(), caller_key_id=str(uuid.uuid4()))
        agen = resp.body_iterator
        first = await agen.__anext__()
        assert task_id in first
        if kind == "revoked":
            second = await agen.__anext__()
            assert "access revoked: key_revoked" in second, second
            with pytest.raises(StopAsyncIteration):
                await agen.__anext__()
        else:
            with pytest.raises(_PastTheCheck):
                await agen.__anext__()


class _Socket:
    def __init__(self) -> None:
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.closed: int | None = None

    async def accept(self) -> None:
        return None

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        if self.closed is None:
            self.closed = code
            await self.inbox.put(None)

    async def send_text(self, text: str) -> None:
        return None

    async def receive_text(self) -> str:
        from fastapi import WebSocketDisconnect

        item = await self.inbox.get()
        if item is None:
            raise WebSocketDisconnect(code=self.closed or 1000)
        return item


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["revoked", "db_error"])
async def test_ws_chat_acts_on_the_verdict(kind):
    import app.routers.ws_chat as ws

    org = uuid.uuid4()
    caller = SimpleNamespace(id=uuid.uuid4(), org_id=org)
    agent = SimpleNamespace(id=uuid.uuid4(), org_id=org, project_id=uuid.uuid4())
    kept: list = []
    session = AsyncMock()
    found = MagicMock(); found.scalar_one_or_none.return_value = agent
    session.execute = AsyncMock(return_value=found)
    session.add = MagicMock(side_effect=kept.append)
    session.refresh = AsyncMock(side_effect=lambda m: setattr(m, "created_at", __import__("datetime").datetime.now()) or setattr(m, "id", uuid.uuid4()))

    @asynccontextmanager
    async def factory():
        yield session

    sock = _Socket()
    with patch.object(ws, "_authenticate", AsyncMock(return_value=caller)), patch.object(ws, "_api_key_id", AsyncMock(return_value=uuid.uuid4())), \
         patch.object(ws, "async_session_factory", factory), patch.object(ws, "_get_or_create_conversation", AsyncMock(return_value=uuid.uuid4())), \
         patch.object(ws, "resolve_member_display_name", AsyncMock(return_value="x")), patch.object(ws, "_broadcast", AsyncMock()), \
         patch.object(ws, "_WS_ACCESS_RECHECK_SEC", 60.0), patch.object(sa, "key_access_revoked_db", _verdict(kind)):
        hub = asyncio.create_task(ws.ws_chat_hub(sock, agent_id=agent.id, api_key="sk_live_x", token=None))
        await sock.inbox.put("hello")
        if kind == "revoked":
            await asyncio.wait_for(hub, 3)
            assert sock.closed == 4001 and kept == []  # closed before keeping anything
        else:
            for _ in range(100):
                if kept:
                    break
                await asyncio.sleep(0.01)
            assert sock.closed is None and len(kept) == 1  # the DB error skipped the check: the message was kept, the socket stays
            await sock.close()
            await asyncio.wait_for(hub, 3)
