"""story #4569 (E-DESKTOP-2 · 4543 r2 · PO 00:55Z) — an agent with a long backlog hears a new message on the same connect / wake.

Before: the connect backfill and each wake sent one batch (`_BACKFILL_LIMIT` = 100) and the next batch waited for the next wake —
Dan (4543 r2) had 2,399 rows waiting, the only wake was a connection_test every ~5 min, so a DM sent at 00:45Z would have reached
him around 03:00Z. Now batches go on until the newest row, on one connect and on one wake: 2,400 rows + 1 new message all go out,
in seq order, each seq once, with the batch size unchanged. Real setup + key + stream over a migrated PG (the 4424 harness);
rows are written as the product writes them (Event → assign_recipient_seq → commit, which wakes the stream).
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _ASYNC,
    ORG,
    PROJ,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _open_setup_stream,
    _quiet_stream_side_effects,
    _sql,
    _StreamRequest,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio

BACKLOG = 2_400
IDLE = 10.0  # no frame for this long = the stream is waiting for a wake (nothing more is coming on this one)


async def _put_backlog_and_a_message(agent_id: str) -> int:
    """BACKLOG connection_test rows, then one message, in one commit; the message's seq.

    The backlog rows take their seqs from `agent_event_seqs` as `assign_recipient_seq` does, but in one statement and with no
    wake (as rows left waiting from before) — so the message's own `assign_recipient_seq` is the single wake. With a wake per
    row the queue would hold many wakes and even one batch per wake would get through; one wake is what Dan had."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            params = {"rid": agent_id, "n": BACKLOG, "org": str(ORG), "proj": str(PROJ)}
            first = (await s.execute(text("""
                INSERT INTO agent_event_seqs(recipient_id, last_seq) VALUES (CAST(:rid AS uuid), :n)
                ON CONFLICT(recipient_id) DO UPDATE SET last_seq = agent_event_seqs.last_seq + :n, updated_at = NOW()
                RETURNING last_seq - :n + 1
            """), params)).scalar_one()
            await s.execute(text("""
                INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
                SELECT gen_random_uuid(), CAST(:proj AS uuid), CAST(:org AS uuid), 'onboarding.connection_test', CAST(:rid AS uuid),
                       'agent', jsonb_build_object('kind', 'connection_test', 'agent_id', :rid), 'pending', :first + i
                FROM generate_series(0, :n - 1) AS i
            """), {**params, "first": first})
            message = Event(project_id=PROJ, org_id=ORG, event_type="conversation.message_created", recipient_id=uuid.UUID(agent_id),
                            recipient_type="agent", payload={"content": "4569 the new message", "conversation_id": str(uuid.uuid4())},
                            status="pending")
            s.add(message)
            await s.flush()
            seq = await assign_recipient_seq(s, message)
            await s.commit()
    finally:
        await eng.dispose()
    return seq


def _seq(frame: str) -> int | None:
    for line in frame.split("\n"):
        if line.startswith("id: "):
            return int(line[4:])
    return None


async def _frames_until_idle(agen, task: asyncio.Future | None = None) -> tuple[list[str], asyncio.Future | None]:
    """Frames until none comes for IDLE seconds; (frames, the read still pending — None if the stream ended). The pending read is
    kept, not cancelled: a cancelled read ends the stream (it takes the cancel as its end)."""
    frames: list[str] = []
    task = task or asyncio.ensure_future(agen.__anext__())
    while True:
        done, _ = await asyncio.wait({task}, timeout=IDLE)
        if not done:
            return frames, task
        try:
            frames.append(task.result())
        except StopAsyncIteration:
            return frames, None
        task = asyncio.ensure_future(agen.__anext__())


async def _read_until_idle(agen, first: asyncio.Future | None = None) -> list[str]:
    """Frames until none comes for IDLE seconds, then the pending read is cancelled (which ends the stream)."""
    frames, task = await _frames_until_idle(agen, first)
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, StopAsyncIteration):
            pass
    return frames


def _assert_all_went_out_once_in_order(frames: list[str], message_seq: int) -> None:
    seqs = [s for s in (_seq(f) for f in frames) if s is not None]
    assert "4569 the new message" in "".join(frames), f"the new message must go out on this one pass ({len(seqs)} rows went out)"
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs)), "seq order, each seq once"
    assert seqs[-1] == message_seq
    backlog = [s for s in seqs if s > message_seq - BACKLOG - 1]
    assert len(backlog) == BACKLOG + 1, f"all {BACKLOG} backlog rows and the message: {len(backlog)}"
    assert not any("access_revoked" in f for f in frames)


async def test_one_connect_sends_the_whole_backlog_and_the_new_message(world, monkeypatch):
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import AuthContext

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    assert ag._BACKFILL_LIMIT == 100  # the batch size stays — the fix is «more batches», not a bigger one
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 connect")
        await agen.aclose()  # the key and agent are made; this first stream is not the one under test
        ag._agent_connections.clear()
        message_seq = await _put_backlog_and_a_message(agent_id)
        # the same agent and key connect again — now with the backlog waiting
        key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{agent_id}' AND revoked_at IS NULL"))[0][0]
        auth = AuthContext(user_id=agent_id, email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})
        agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
        try:
            assert "event: heartbeat" in await agen.__anext__()
            frames = await _read_until_idle(agen)
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    assert all('"is_backfill": true' in f for f in frames if _seq(f) is not None)
    _assert_all_went_out_once_in_order(frames, message_seq)


async def test_one_wake_sends_the_whole_backlog_and_the_new_message(world, monkeypatch):
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 wake")
        try:
            assert "event: heartbeat" in await agen.__anext__()
            # past the backfill (the setup leaves an event of its own) into the wait for a signal — the same read stays pending
            pending = asyncio.ensure_future(agen.__anext__())
            for _ in range(20):
                await asyncio.sleep(0.2)
                if not pending.done():
                    break
                assert "4569" not in pending.result()
                pending = asyncio.ensure_future(agen.__anext__())
            assert not pending.done()
            message_seq = await _put_backlog_and_a_message(agent_id)  # one commit → one wake
            frames = await _read_until_idle(agen, first=pending)
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    assert all('"is_backfill": false' in f for f in frames if _seq(f) is not None)
    _assert_all_went_out_once_in_order(frames, message_seq)


async def _put_one_event(agent_id: str, content: str) -> int:
    """One more row through the product path (its own commit → its own wake)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            event = Event(project_id=PROJ, org_id=ORG, event_type="conversation.message_created", recipient_id=uuid.UUID(agent_id),
                          recipient_type="agent", payload={"content": content, "conversation_id": str(uuid.uuid4())}, status="pending")
            s.add(event)
            await s.flush()
            seq = await assign_recipient_seq(s, event)
            await s.commit()
    finally:
        await eng.dispose()
    return seq


async def test_wakes_before_the_ack_catches_up_do_not_send_the_tail_again(world, monkeypatch):
    """PO 01:14Z — each wake rescans from acked_seq (late commits are caught that way); now that a pass sends the whole tail, a wake
    that comes before the client's ack has caught up must not send that tail again. 2,400 waiting + 1 message on one wake, then 3
    new events in quick succession (3 more wakes), no ack at all (the worst case): every seq goes out once."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 wakes before ack")
        try:
            assert "event: heartbeat" in await agen.__anext__()
            pending = asyncio.ensure_future(agen.__anext__())
            for _ in range(20):
                await asyncio.sleep(0.2)
                if not pending.done():
                    break
                pending = asyncio.ensure_future(agen.__anext__())
            assert not pending.done()
            await _put_backlog_and_a_message(agent_id)
            news = [await _put_one_event(agent_id, f"4569 quick {i}") for i in range(3)]
            frames = await _read_until_idle(agen, first=pending)
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    seqs = [s for s in (_seq(f) for f in frames) if s is not None]
    assert news[-1] in seqs, "the last new event goes out"
    assert len(seqs) == len(set(seqs)), f"a seq goes out once on this connection: {len(seqs)} frames · {len(set(seqs))} unique"


async def test_a_late_commit_below_what_went_out_still_goes_out(world, monkeypatch):
    """The skip is «sent on this connection», not «below the highest sent»: a row whose seq is below what already went out but that
    was not there then (a late commit — the reason a wake rescans from acked_seq) still goes out on the next wake. Made here as a
    hole in the seqs that is filled after the rows above it went out."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 late commit")
        try:
            assert "event: heartbeat" in await agen.__anext__()
            pending = asyncio.ensure_future(agen.__anext__())
            for _ in range(20):
                await asyncio.sleep(0.2)
                if not pending.done():
                    break
                pending = asyncio.ensure_future(agen.__anext__())
            assert not pending.done()
            top = (await _sql(fetch=f"SELECT last_seq FROM agent_event_seqs WHERE recipient_id='{agent_id}'"))[0][0]
            hole = top + 1
            # seqs top+2 .. top+250 go in now (with no row at `hole`), the counter moves past them, one wake
            await _sql(
                f"UPDATE agent_event_seqs SET last_seq = {top + 250} WHERE recipient_id='{agent_id}'",
                f"""INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
                    SELECT gen_random_uuid(), '{PROJ}', '{ORG}', 'onboarding.connection_test', '{agent_id}', 'agent',
                           '{{"kind": "connection_test"}}'::jsonb, 'pending', s FROM generate_series({top + 2}, {top + 250}) AS s""",
            )
            ag.wake_agent(agent_id, top + 250)
            first, pending = await _frames_until_idle(agen, pending)
            assert pending is not None, "the stream is still open"
            # the hole is filled now (the late commit), one wake
            await _sql(
                f"""INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
                    VALUES (gen_random_uuid(), '{PROJ}', '{ORG}', 'conversation.message_created', '{agent_id}', 'agent',
                            '{{"content": "4569 late"}}'::jsonb, 'pending', {hole})""",
            )
            ag.wake_agent(agent_id, hole)
            second = await _read_until_idle(agen, first=pending)
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    sent_first = [s for s in (_seq(f) for f in first) if s is not None]
    sent_second = [s for s in (_seq(f) for f in second) if s is not None]
    assert sent_first and sent_first[-1] == top + 250 and hole not in sent_first
    assert sent_second == [hole], f"only the late row goes out, once: {sent_second[:5]}"


async def _ack(auth, seq: int) -> None:
    """The client's ack through the real handler (POST /api/v2/agent/events/ack), as a daemon sends it."""
    import app.routers.agent_gateway as ag
    from app.core.database import async_session_factory

    async with async_session_factory() as db:
        await ag.ack_event(ag.AckRequest(seq=seq), db=db, auth=auth)


async def _agent_auth(agent_id: str):
    from app.dependencies.auth import AuthContext

    key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{agent_id}' AND revoked_at IS NULL"))[0][0]
    return AuthContext(user_id=agent_id, email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})


async def test_a_new_connection_starts_again_from_the_ack(world, monkeypatch):
    """The «already sent» set is per connection and the ack is the only cursor: 2,400 + 1 go out, the client acks part of them (the
    real ack handler), the stream ends, the same key connects again → exactly everything after the ack, once, in order."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 reconnect")
        await agen.aclose()
        ag._agent_connections.clear()
        message_seq = await _put_backlog_and_a_message(agent_id)
        auth = await _agent_auth(agent_id)
        acked = message_seq - 1_000
        passes = []
        try:
            for i in range(2):
                agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
                try:
                    assert "event: heartbeat" in await agen.__anext__()
                    passes.append(await _read_until_idle(agen))
                finally:
                    await agen.aclose()
                    ag._agent_connections.clear()
                if i == 0:
                    await _ack(auth, acked)
        finally:
            shutdown_module.reset_shutdown_event()
    _assert_all_went_out_once_in_order(passes[0], message_seq)
    again = [s for s in (_seq(f) for f in passes[1]) if s is not None]
    assert again == list(range(acked + 1, message_seq + 1)), f"from the ack on, once, in order: {again[:3]} … {again[-3:]}"


async def test_an_ack_on_the_same_connection_trims_what_it_keeps_and_a_late_commit_still_goes_out(world, monkeypatch):
    """Qadir 02:06Z ① — on a wake the sent-but-not-acked set drops what the client acked (its size stays the not-acked count), and a
    late commit above the ack still goes out once. Seqs top+1..top+100 and top+102..top+250 go out (a hole at top+101), the client
    acks top+100 (the real handler), the hole is filled, one wake → only the hole goes out, and the set holds nothing ≤ the ack."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    made: list = []

    class _Spy(ag._SentUnacked):
        def __init__(self, *a):
            super().__init__(*a)
            made.append(self)

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    monkeypatch.setattr(ag, "_SentUnacked", _Spy)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 ack trims")
        auth = await _agent_auth(agent_id)
        pending = None
        try:
            assert "event: heartbeat" in await agen.__anext__()
            pending = asyncio.ensure_future(agen.__anext__())
            for _ in range(20):
                await asyncio.sleep(0.2)
                if not pending.done():
                    break
                pending = asyncio.ensure_future(agen.__anext__())
            assert not pending.done()
            top = (await _sql(fetch=f"SELECT last_seq FROM agent_event_seqs WHERE recipient_id='{agent_id}'"))[0][0]
            hole = top + 101
            rows = "SELECT gen_random_uuid(), '{p}', '{o}', 'onboarding.connection_test', '{a}', 'agent', '{{\"kind\": \"connection_test\"}}'::jsonb, 'pending', s FROM generate_series({lo}, {hi}) AS s"
            await _sql(
                f"UPDATE agent_event_seqs SET last_seq = {top + 250} WHERE recipient_id='{agent_id}'",
                "INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq) "
                + rows.format(p=PROJ, o=ORG, a=agent_id, lo=top + 1, hi=top + 100),
                "INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq) "
                + rows.format(p=PROJ, o=ORG, a=agent_id, lo=top + 102, hi=top + 250),
            )
            ag.wake_agent(agent_id, top + 250)
            first, pending = await _frames_until_idle(agen, pending)
            assert pending is not None, "the stream is still open"
            await _ack(auth, top + 100)
            await _sql(
                f"""INSERT INTO events (id, project_id, org_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq)
                    VALUES (gen_random_uuid(), '{PROJ}', '{ORG}', 'conversation.message_created', '{agent_id}', 'agent',
                            '{{"content": "4569 late after ack"}}'::jsonb, 'pending', {hole})""",
            )
            ag.wake_agent(agent_id, hole)
            second, pending = await _frames_until_idle(agen, pending)
            assert pending is not None, "the stream is still open"
            kept = set(made[-1])
        finally:
            if pending is not None and not pending.done():
                pending.cancel()  # the stream takes the cancel as its end
                try:
                    await pending
                except (asyncio.CancelledError, StopAsyncIteration):
                    pass
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    sent_first = [s for s in (_seq(f) for f in first) if s is not None]
    assert sent_first[-1] == top + 250 and hole not in sent_first
    assert [s for s in (_seq(f) for f in second) if s is not None] == [hole], "only the late row, once"
    assert not any(s <= top + 100 for s in kept), f"what the client acked is dropped: {sorted(s for s in kept if s <= top + 100)[:5]}"
    assert kept == set(range(top + 101, top + 251)), "the set holds exactly what went out and is not acked yet"


async def test_a_long_catch_up_to_a_slow_reader_keeps_presence_and_lease_fresh(world, monkeypatch):
    """PO 01:28Z · Qadir ④ — a pass runs to the end before the outer loop turns, and a desktop daemon reads one frame at a time
    (fsync + ack each: 2,400 × ~40 ms ≈ 96 s > the 90 s presence / lease TTL). The connection's tick (presence + lease refresh) runs
    between batches too. Here the tick is due every 0.5 s and the reader takes 2 ms a frame (2,401 frames ≥ 4.8 s): the lease is
    refreshed several times while the pass is still going (without the between-batch tick: not once — the outer loop is not
    reached until the pass ends)."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module
    from app.services import sse_lease

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    monkeypatch.setattr(ag, "_PRESENCE_TICK_INTERVAL", 0.5)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 slow reader")
        try:
            assert "event: heartbeat" in await agen.__anext__()
            pending = asyncio.ensure_future(agen.__anext__())
            for _ in range(20):
                await asyncio.sleep(0.2)
                if not pending.done():
                    break
                pending = asyncio.ensure_future(agen.__anext__())
            assert not pending.done()
            message_seq = await _put_backlog_and_a_message(agent_id)
            refreshes_before = sse_lease.refresh.await_count
            frames = [await pending]
            while "4569 the new message" not in frames[-1]:
                await asyncio.sleep(0.002)  # the slow reader
                frames.append(await agen.__anext__())
            refreshes_during = sse_lease.refresh.await_count - refreshes_before
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
            shutdown_module.reset_shutdown_event()
    assert _seq(frames[-1]) == message_seq
    assert refreshes_during >= 3, f"the lease is refreshed while a long pass goes on: {refreshes_during} refreshes in {len(frames)} frames"


async def test_a_long_catch_up_never_keeps_the_stream_past_its_lifespan(world, monkeypatch):
    """PO 01:49Z · Qadir ⑤ (#2128 lifespan) — the lifespan is measured between batches too: a catch-up to a slow reader that runs
    past it ends with lifespan_reconnect before the rest goes out, and the next connection goes on from the ack (nothing lost).
    Lifespan 1 s (no jitter) · reader 2 ms a frame · 2,401 frames (≥ 4.8 s)."""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    _quiet_stream_side_effects(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4569 lifespan")
        await agen.aclose()
        ag._agent_connections.clear()
        message_seq = await _put_backlog_and_a_message(agent_id)
        auth = await _agent_auth(agent_id)
        try:
            monkeypatch.setattr(ag, "_AGENT_SSE_LIFESPAN_SEC", 1.0)
            monkeypatch.setattr(ag, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0)
            agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
            short: list[str] = []
            try:
                assert "event: heartbeat" in await agen.__anext__()
                async for frame in agen:
                    short.append(frame)
                    await asyncio.sleep(0.002)  # the slow reader
            finally:
                await agen.aclose()
                ag._agent_connections.clear()
            monkeypatch.setattr(ag, "_AGENT_SSE_LIFESPAN_SEC", 300.0)
            agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
            try:
                assert "event: heartbeat" in await agen.__anext__()
                again = await _read_until_idle(agen)
            finally:
                await agen.aclose()
                ag._agent_connections.clear()
        finally:
            shutdown_module.reset_shutdown_event()
    assert short and short[-1].startswith("event: lifespan_reconnect"), f"the pass ends at the lifespan: {short[-1][:60] if short else None}"
    assert "4569 the new message" not in "".join(short), "the pass stopped before the end of the backlog"
    _assert_all_went_out_once_in_order(again, message_seq)  # nothing acked → the next connection sends all after the ack
