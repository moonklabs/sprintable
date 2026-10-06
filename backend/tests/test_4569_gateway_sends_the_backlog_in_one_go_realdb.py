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


async def _read_until_idle(agen, first: asyncio.Future | None = None) -> list[str]:
    """Frames until none comes for IDLE seconds (the pending read is cancelled — the stream treats that as its end)."""
    frames: list[str] = []
    task = first or asyncio.ensure_future(agen.__anext__())
    while True:
        done, _ = await asyncio.wait({task}, timeout=IDLE)
        if not done:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
            return frames
        try:
            frames.append(task.result())
        except StopAsyncIteration:
            return frames
        task = asyncio.ensure_future(agen.__anext__())


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
