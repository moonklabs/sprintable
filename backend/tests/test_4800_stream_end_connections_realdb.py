"""story 4800 — a stream that ends because its client went away gives its database connections back.

Kadir's measure on a real uvicorn (10-26, PR 5265): 31 connects, each cut by the client (FIN · RST) → `sqlalchemy.pool … Exception terminating connection` 31 times (once per connect) and
`garbage collector is trying to clean up non-checked-in connection` 27 times — the same before 5265. Cause: Starlette ends the stream inside an anyio cancel scope when the client goes away, and that
cancellation is LEVEL-triggered: every real `await` left in the stream's `finally` raises CancelledError again, so the connection-end work (`_mark_agent_disconnected` opens a session and awaits) is cut in the
middle of a query / of the session's own `close()` and the pooled connection is neither returned nor closed until the garbage collector finds it.
These tests end the stream the way a real server does (the real `StreamingResponse.__call__` answering `http.disconnect`) N times and count: the connections the pool still lends out, the pool's
«Exception terminating connection» records, and the SQLAlchemy «non-checked-in connection» warnings — all three must be 0 — and that the cleanup work itself got done (the session row is gone)."""
from __future__ import annotations

import gc
import logging
import os
import warnings

import pytest

from tests.test_4788_replay_floor_realdb import _connect_as, _key, _world_prod
from tests.test_4788_agent_stream_replay_realdb import _cleanup

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
    pytest.mark.anyio,
]

N = 12


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _no_floor(monkeypatch):
    """(the replay count of story 4788 is not under test here and would add a task per connect)"""
    from app.services import agent_stream_replay_floor as f

    monkeypatch.setattr(f, "ATTEMPTS", 0)


async def _measure(monkeypatch, caplog, n: int = N):
    ag, engine, Session, ids = await _world_prod(monkeypatch, tail=3)
    try:
        key = await _key(Session, ids)
        with warnings.catch_warnings(record=True) as caught, caplog.at_level(logging.ERROR, logger="sqlalchemy.pool"):
            warnings.simplefilter("always")
            for _ in range(n):
                frames = await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)
                assert len(frames) == 3
            lent_out = engine.sync_engine.pool.checkedout()  # before any garbage collection: what the streams did not give back
            gc.collect()
            await __import__("asyncio").sleep(0.2)
            gc.collect()
        terminating = sum("Exception terminating connection" in r.getMessage() for r in caplog.records)
        non_checked_in = sum("non-checked-in connection" in str(w.message) for w in caught)
        from sqlalchemy import text

        async with Session() as s:
            sessions_left = (await s.execute(text("SELECT count(*) FROM agent_gateway_sessions WHERE agent_id = :a"), {"a": ids[2]})).scalar_one()
        return lent_out, terminating, non_checked_in, sessions_left, (ag, engine, ids)
    except BaseException:
        await _cleanup(ag, engine, ids[2])
        raise


async def test_01_streams_ended_by_the_client_give_their_connections_back(monkeypatch, caplog):
    lent_out, terminating, non_checked_in, sessions_left, (ag, engine, ids) = await _measure(monkeypatch, caplog)
    try:
        print(f"\n[4800] {N} streams cut by the client → pool still lends out {lent_out} · «Exception terminating connection» {terminating} · «non-checked-in connection» {non_checked_in} · session rows left {sessions_left}")
        assert lent_out == 0, "the pool still lends out connections the streams never gave back"
        assert terminating == 0
        assert non_checked_in == 0
        assert sessions_left == 0, "the connection-end work (the session row's removal) was cut off"
    finally:
        await _cleanup(ag, engine, ids[2])
