"""story #4864 — the request pool must name whoever holds its connections, and a session stuck in an open transaction must not live for hours.

Real Postgres (PARITY_DATABASE_URL / ALEMBIC_DATABASE_URL), no schema needed: only `select 1`, `show`, `pg_stat_activity`.

① a checked-out connection is written down (route · where it was taken) and is gone from the list at checkin
② a connection held longer than the warn line gives ONE report line: counts · age · route · where the holder waits now · where it was taken; a calm pool gives none
③ a connection the holding task never gave back (the task finished) is counted as `leaked` — a leak is not a wait
④ SQLAlchemy's «garbage collector is trying to clean up non-checked-in connection» line gets «checked out at: …» appended
⑤ the request engine asks the database to end sessions idle in a transaction (`idle_in_transaction_session_timeout`) — and the database does (a session that sits in a transaction past the
   line is ended); not sent in PgBouncer mode, not when switched off
"""
from __future__ import annotations

import asyncio
import logging
import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

_REAL_DB_URL = os.environ.get("PARITY_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")


@pytest.fixture
async def watched():
    """A small engine of its own, under the module's registry with a unique name; the registry entry is removed afterwards."""
    from app.core import pool_holders

    name = f"t4864-{os.getpid()}-{id(object())}"
    eng = create_async_engine(_async_url(), pool_size=2, max_overflow=1, pool_pre_ping=True)
    pool_holders.install(eng, name)
    yield name, eng
    await eng.dispose()
    pool_holders._pools.pop(name, None)


async def test_checkout_is_listed_with_its_place_and_gone_at_checkin(watched):
    from app.core import pool_holders

    name, eng = watched

    async def holder():
        async with eng.connect() as conn:
            await conn.execute(text("select 1"))
            return pool_holders.snapshot(name)

    held = await holder()
    assert len(held) == 1
    # the place it was taken at is an app frame of THIS file's coroutine chain only when the file is under app/ — here it is a test file, so the chain is empty but the entry exists
    assert held[0]["age"] >= 0 and held[0]["leak"] is False
    # the checkin listener itself removes the entry — read the registry BEFORE snapshot() (which prunes checked-in records on its own and would hide a missing listener)
    reg = pool_holders._pools[name]
    assert reg.holders == {} and reg.by_conn == {}, "checkin must remove the entry (both maps)"
    assert pool_holders.snapshot(name) == []


async def test_report_line_for_a_long_hold_and_none_for_a_calm_pool(watched):
    from app.core import pool_holders

    name, eng = watched
    assert [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l] == []  # nothing out → nothing to say

    release = asyncio.Event()

    async def holder():
        async with eng.connect() as conn:
            await conn.execute(text("select 1"))
            await release.wait()  # holds the connection and waits

    t = asyncio.create_task(holder())
    await asyncio.sleep(0.5)
    lines = [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l]
    release.set()
    await t
    assert len(lines) == 1, lines
    line = lines[0]
    assert "checked_out=1/3" in line and "held_over_0s=1" in line and "leaked=0" in line, line
    assert "now at" in line and "checked out at" in line, line
    # and the pool is calm again afterwards
    assert [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l] == []


async def test_a_connection_never_given_back_by_a_finished_task_counts_as_leaked(watched):
    from app.core import pool_holders

    name, eng = watched
    keep = []

    async def take_and_forget():
        conn = await eng.connect()  # never closed
        await conn.execute(text("select 1"))
        keep.append(conn)  # keeps it referenced (a real leak is often referenced too) — the task ends here

    await asyncio.create_task(take_and_forget())
    held = pool_holders.snapshot(name)
    assert len(held) == 1 and held[0]["leak"] is True
    line = [l for l in pool_holders.report_lines(warn_sec=0.0) if f"pool={name} " in l][0]
    assert "leaked=1" in line, line
    await keep[0].close()


async def test_the_real_garbage_collector_line_gets_the_suffix(watched):
    """SQLAlchemy writes this line itself (no log args) and names the DRIVER connection by its address — the fake-record test below cannot see that."""
    import gc
    import io
    import warnings

    name, eng = watched
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    pool_log = logging.getLogger("sqlalchemy.pool")
    pool_log.addHandler(handler)
    old_level = pool_log.level
    pool_log.setLevel(logging.WARNING)

    async def leaky():
        conn = await eng.connect()
        await conn.execute(text("select 1"))  # the task ends; the connection object is dropped without close

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # SAWarning twin of the same event
            await asyncio.create_task(leaky())
            gc.collect()
            await asyncio.sleep(0.3)
            gc.collect()
        out = buf.getvalue()
    finally:
        pool_log.removeHandler(handler)
        pool_log.setLevel(old_level)
    assert "non-checked-in connection" in out, out
    assert f"pool_holders: pool={name} " in out and "checked out at:" in out, out


def test_the_garbage_collector_line_gets_the_place_it_was_checked_out_at(watched_sync=None):
    from app.core import pool_holders

    pool_holders._pools["t4864-gc"] = pool = pool_holders._Pool("t4864-gc", engine=None)
    try:
        fake_conn = object()

        class _T:
            def done(self):
                return False

        h = pool_holders._Holder.__new__(pool_holders._Holder)
        h.since = pool_holders.time.monotonic() - 42
        h.task = None
        h.scope = {"method": "GET", "route": type("R", (), {"path": "/api/v2/example"})()}
        h.record = lambda: None
        h.chain = ["app/routers/a.py:10 outer", "app/services/b.py:20 inner"]
        h.conn_id = id(fake_conn)
        pool.by_conn[h.conn_id] = h
        rec = logging.LogRecord("sqlalchemy.pool.impl.AsyncAdaptedQueuePool", logging.ERROR, __file__, 1,
                                "The garbage collector is trying to clean up non-checked-in connection %s, which will be terminated.", (fake_conn,), None)
        assert pool_holders._GcLineFilter().filter(rec) is True
        msg = rec.getMessage()
        assert "non-checked-in connection" in msg and "pool=t4864-gc" in msg
        assert "GET /api/v2/example" in msg
        assert "app/services/b.py:20 inner ← app/routers/a.py:10 outer" in msg, msg
        # an unrelated log line is left alone
        other = logging.LogRecord("x", logging.ERROR, __file__, 1, "something else %s", (fake_conn,), None)
        pool_holders._GcLineFilter().filter(other)
        assert other.getMessage().startswith("something else")
    finally:
        pool_holders._pools.pop("t4864-gc", None)


async def test_the_request_engine_ends_sessions_idle_in_a_transaction(monkeypatch):
    from app.core import database

    monkeypatch.setattr(database.settings, "db_pgbouncer", False)
    monkeypatch.setattr(database.settings, "db_idle_in_txn_timeout_ms", 1500)
    kw = database._build_engine_kwargs()
    assert kw["connect_args"]["server_settings"]["idle_in_transaction_session_timeout"] == "1500"

    # PgBouncer refuses unknown startup parameters; and 0 = off
    monkeypatch.setattr(database.settings, "db_pgbouncer", True)
    assert "idle_in_transaction_session_timeout" not in database._build_engine_kwargs()["connect_args"]["server_settings"]
    monkeypatch.setattr(database.settings, "db_pgbouncer", False)
    monkeypatch.setattr(database.settings, "db_idle_in_txn_timeout_ms", 0)
    assert "idle_in_transaction_session_timeout" not in database._build_engine_kwargs()["connect_args"]["server_settings"]

    # the database really ends such a session (an engine built with these kwargs; the line is 1.5 s here)
    monkeypatch.setattr(database.settings, "db_idle_in_txn_timeout_ms", 1500)
    eng = create_async_engine(_async_url(), pool_size=1, max_overflow=0, connect_args=database._build_engine_kwargs()["connect_args"])
    try:
        async with eng.connect() as conn:
            assert (await conn.execute(text("show idle_in_transaction_session_timeout"))).scalar() == "1500ms"
            await asyncio.sleep(2.5)  # sits inside the transaction the first statement opened
            with pytest.raises(Exception) as err:
                await conn.execute(text("select 1"))
            assert "terminat" in str(err.value).lower() or "connection" in str(err.value).lower()
    finally:
        await eng.dispose()
