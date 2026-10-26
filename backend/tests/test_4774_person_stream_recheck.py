"""story #4774 — the recheck of a connection a PERSON opened (`SeatRecheck`, services/stream_access.py), pinned where it lives and on each connection that uses it
(no DB: the check's DB step is replaced; the real-PG cells are in test_4774_open_connections_recheck_realdb.py):

1. an id that is not a UUID closes («seat_ended») — the DB is not asked (fail closed, as a key id does)
2. a DB error or timeout skips that one check (None) with a log line; any other error propagates
3. unlike a key's recheck it is asked EVERY time (`age` ignored)
4. /events/stream (person) and the A2A streaming reply each act on the verdict: seat ended → the stream ends with the revoked frame · DB error → it goes on
5. a key's connection is unchanged: the person's check is never asked for it."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.services import stream_access as sa
from tests.test_4565_stream_access_rules import _Request


@pytest.fixture
def anyio_backend():
    return "asyncio"


USER = uuid.UUID("d4774000-0000-0000-0000-0000000000a1")
ORG = uuid.UUID("d4774000-0000-0000-0000-0000000000b1")


def _verdict(kind: str, asked: list | None = None):
    """The check's DB step for a case; `asked` collects the (user, organization) it was asked about — a stream that handed over the wrong ones would not pass."""
    async def step(user_id, org_id):
        if asked is not None:
            asked.append((user_id, org_id))
        if kind == "ended":
            return "seat_ended"
        if kind == "seated":
            return None
        raise SQLAlchemyError("db down")
    return step


@pytest.mark.anyio
@pytest.mark.parametrize("user_id,org_id", [("not-a-uuid", ORG), (USER, "x"), (None, ORG), (USER, None)])
async def test_an_id_that_is_not_a_uuid_closes_without_asking_the_db(user_id, org_id):
    asked = AsyncMock(return_value=None)
    assert await sa.person_seat_revoked(user_id, org_id, db_check=asked) == "seat_ended"
    asked.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("error", [SQLAlchemyError("db down"), TimeoutError("pool")])
async def test_a_db_error_or_timeout_skips_that_one_check_with_a_log_line(error, caplog):
    caplog.set_level(logging.WARNING, logger="app.services.stream_access")
    assert await sa.person_seat_revoked(USER, ORG, db_check=AsyncMock(side_effect=error)) is None
    assert any("stream seat recheck failed" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
async def test_any_other_error_propagates():
    with pytest.raises(ValueError):
        await sa.person_seat_revoked(USER, ORG, db_check=AsyncMock(side_effect=ValueError("a bug in the check")))


@pytest.mark.anyio
async def test_a_persons_recheck_is_asked_every_time_whatever_the_age():
    step = AsyncMock(return_value=None)
    r = sa.SeatRecheck(USER, ORG, db_check=step)
    for age in (0, 60, 10_000):
        assert await r.due(age) is None
    assert step.await_count == 3


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["ended", "db_error"])
async def test_events_stream_of_a_person_acts_on_the_verdict(kind, caplog):
    import app.routers.events as ev

    caplog.set_level(logging.WARNING, logger="app.services.stream_access")
    member = uuid.uuid4()
    org = uuid.uuid4()
    session = AsyncMock()
    pending = MagicMock(); pending.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(return_value=pending)

    @asynccontextmanager
    async def factory():
        yield session

    auth = MagicMock(); auth.user_id = str(USER)
    auth.claims = {"app_metadata": {"org_id": str(org)}}   # a JWT: no api_key_id
    frames: list[str] = []
    asked: list = []
    try:
        with patch("app.core.database.async_session_factory", factory), patch.object(sa, "person_seat_revoked_db", _verdict(kind, asked)), \
             patch.object(ev, "resolve_member_identity", AsyncMock(return_value=SimpleNamespace(id=member, user_id=USER))), \
             patch.object(ev, "_SSE_HEARTBEAT_TIMEOUT", 0.02), patch("app.services.sse_lease.refresh", AsyncMock()):
            resp = await ev.agent_event_stream(request=_Request(), member_id=member, auth=auth, org_id=org, since_timestamp=None, last_event_id=None)
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
    assert asked and set(asked) == {(USER, org)}, asked
    revoked = [f for f in frames if f.startswith("event: access_revoked")]
    if kind == "ended":
        assert revoked and json.loads(revoked[0].split("data: ", 1)[1]) == {"reason": "seat_ended"}, frames
        assert ended and frames[-1] is revoked[0], frames
    else:
        assert not revoked and sum("heartbeat" in f for f in frames) >= 3, frames
        assert any("stream seat recheck failed" in r.getMessage() for r in caplog.records)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["ended", "db_error"])
async def test_a2a_streaming_reply_of_a_person_acts_on_the_verdict(kind):
    import app.routers.a2a as a2a

    task_id = str(uuid.uuid4())
    sent = {"task": {"id": task_id, "contextId": "c", "status": {"state": "working"}}}

    class _PastTheCheck(Exception):
        """the stream went on past the recheck (it reached its own DB poll)"""

    def poll_factory():
        raise _PastTheCheck()

    member = SimpleNamespace(id=uuid.uuid4())
    asked: list = []
    with patch.object(a2a, "_handle_send_message", AsyncMock(return_value=sent)), patch.object(a2a, "RECHECK_BEFORE_SEND_SEC", 0), \
         patch.object(a2a, "async_session_factory", poll_factory), patch.object(sa, "person_seat_revoked_db", _verdict(kind, asked)):
        resp = await a2a._stream_send_message(_Request(), 1, AsyncMock(), member, ORG, {}, frozenset(), caller_user_id=str(USER))
        agen = resp.body_iterator
        assert task_id in await agen.__anext__()
        if kind == "ended":
            assert "access revoked: seat_ended" in await agen.__anext__()
            with pytest.raises(StopAsyncIteration):
                await agen.__anext__()
        else:
            with pytest.raises(_PastTheCheck):
                await agen.__anext__()
        assert asked and set(asked) == {(USER, ORG)}, asked


@pytest.mark.anyio
async def test_a2a_route_hands_the_persons_id_to_the_stream_check():
    """Through the route (a2a_rpc): the person's user id reaches the stream's recheck — a route that dropped it would stream on."""
    import app.routers.a2a as a2a

    task_id = str(uuid.uuid4())
    sent = {"task": {"id": task_id, "contextId": "c", "status": {"state": "working"}}}

    def poll_factory():
        raise AssertionError("streamed on past the recheck — the route did not hand the person over")

    auth = MagicMock(); auth.user_id = str(USER)
    auth.claims = {"app_metadata": {}}
    body = a2a.JsonRpcRequest(jsonrpc="2.0", id=1, method="SendStreamingMessage", params={})
    asked: list = []
    with patch.object(a2a, "_get_agent_member", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4()))), \
         patch.object(a2a, "_handle_send_message", AsyncMock(return_value=sent)), patch.object(a2a, "RECHECK_BEFORE_SEND_SEC", 0), \
         patch.object(a2a, "async_session_factory", poll_factory), patch.object(sa, "person_seat_revoked_db", _verdict("ended", asked)):
        resp = await a2a.a2a_rpc(_Request(), uuid.uuid4(), body, org_id=ORG, auth=auth, session=AsyncMock())
        agen = resp.body_iterator
        assert task_id in await agen.__anext__()
        assert "access revoked: seat_ended" in await agen.__anext__()
    assert asked == [(USER, ORG)], asked


@pytest.mark.anyio
async def test_a_keys_stream_never_asks_the_persons_check():
    import app.routers.a2a as a2a

    task_id = str(uuid.uuid4())
    sent = {"task": {"id": task_id, "contextId": "c", "status": {"state": "working"}}}

    class _PastTheCheck(Exception):
        pass

    def poll_factory():
        raise _PastTheCheck()

    async def key_ok(key_uuid, member_id, *, agent_only=True):
        return None

    person = AsyncMock(return_value="seat_ended")
    with patch.object(a2a, "_handle_send_message", AsyncMock(return_value=sent)), patch.object(a2a, "RECHECK_BEFORE_SEND_SEC", 0), \
         patch.object(a2a, "async_session_factory", poll_factory), patch.object(sa, "key_access_revoked_db", key_ok), patch.object(sa, "person_seat_revoked_db", person):
        resp = await a2a._stream_send_message(_Request(), 1, AsyncMock(), SimpleNamespace(id=uuid.uuid4()), ORG, {}, frozenset(),
                                              caller_key_id=str(uuid.uuid4()), caller_user_id=str(USER))
        agen = resp.body_iterator
        await agen.__anext__()
        with pytest.raises(_PastTheCheck):
            await agen.__anext__()
    person.assert_not_called()
