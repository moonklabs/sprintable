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


async def _until(pred, timeout: float = 8.0, step: float = 0.05):
    """Poll instead of sleeping a guessed time (Kadir's 4% flake on slow machines): True as soon as `pred()` holds."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(step)
    return pred()


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
    mine = lambda: [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l]  # noqa: E731
    assert await _until(lambda: len(mine()) == 1), "no report line for a connection held past the warn line"
    lines = mine()
    release.set()
    await t
    assert len(lines) == 1, lines
    line = lines[0]
    assert "checked_out=1/3" in line and "held_over_0s=1" in line and "leaked=0" in line, line
    assert "now at" in line and "checked out at" in line, line
    # and the pool is calm again afterwards
    assert [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l] == []


async def test_only_the_connection_marked_long_lived_is_left_out_of_the_age_rule():
    """The L2 worker's advisory-lock connection is held for the process's life on purpose and must not write a line every poll forever — but ONLY that one: any other connection of the same
    pool held past the line still does (codex on 5452: exempting the whole worker pool hid a hung cron beside the lock connection). Nearly full still speaks."""
    from app.core import pool_holders

    name = f"t4867-{os.getpid()}-{id(object())}"
    eng = create_async_engine(_async_url(), pool_size=2, max_overflow=1)
    pool_holders.install(eng, name)
    mine = lambda: [l for l in pool_holders.report_lines(warn_sec=0.2) if f"pool={name} " in l]  # noqa: E731
    try:
        release_a, release_b = asyncio.Event(), asyncio.Event()
        marked = asyncio.Event()

        async def hold_long():  # the «lock connection»
            async with eng.connect() as conn:
                await conn.execute(text("select 1"))
                await pool_holders.mark_long_lived(conn, name)
                marked.set()
                await release_a.wait()

        async def hold_plain(release):
            async with eng.connect() as conn:
                await conn.execute(text("select 1"))
                await release.wait()

        # the plain connection is held FIRST, then the marked one joins: a mark that exempted more than its own connection (the whole pool, every connection held at that moment) would hide this one
        tb = asyncio.create_task(hold_plain(release_b))
        assert await _until(lambda: len(mine()) == 1), "an unmarked connection past the line must be reported"
        assert "checked_out=1/3" in mine()[0] and "held_over_0s=1" in mine()[0], mine()
        ta = asyncio.create_task(hold_long())
        await asyncio.wait_for(marked.wait(), 8)
        await asyncio.sleep(0.5)  # well past the 0.2 s line for the marked one as well
        line = mine()
        assert len(line) == 1 and "checked_out=2/3" in line[0] and "held_over_0s=1" in line[0], line  # the marked one is NOT counted, the plain one still is
        release_b.set()
        await tb
        assert await _until(lambda: mine() == []), "the marked connection alone: quiet however old"
        # nearly full (3 of 3) speaks whatever the marks say
        extra_release = asyncio.Event()
        more = [asyncio.create_task(hold_plain(extra_release)), asyncio.create_task(hold_plain(extra_release))]
        assert await _until(lambda: len(mine()) == 1)
        assert "checked_out=3/3" in mine()[0], mine()
        extra_release.set()
        release_a.set()
        await asyncio.gather(ta, *more)
    finally:
        await eng.dispose()
        pool_holders._pools.pop(name, None)


async def test_the_route_and_the_await_chain_reach_the_holder_through_the_middleware(watched, monkeypatch):
    """codex round: the other tests build the scope and the chain by hand. Here a real request goes through PoolHolderScopeMiddleware + FastAPI routing and takes a connection:
    the holder must name the route TEMPLATE (never the path value) and the app frames that were awaiting. Test frames stand in for «app/» frames."""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.core import pool_holders

    name, eng = watched
    monkeypatch.setattr(pool_holders, "_APP_MARK", "/tests/")
    entered, release = asyncio.Event(), asyncio.Event()

    async def _take_a_connection():
        async with eng.connect() as conn:
            await conn.execute(text("select 1"))
            entered.set()
            await release.wait()

    app = FastAPI()

    @app.get("/items/{item_id}")
    async def item(item_id: str):
        await _take_a_connection()
        return {"ok": True}

    wrapped = pool_holders.PoolHolderScopeMiddleware(app)
    async with AsyncClient(transport=ASGITransport(app=wrapped), base_url="http://t") as client:
        request = asyncio.create_task(client.get("/items/abc123-secret"))
        await asyncio.wait_for(entered.wait(), 8)
        held = pool_holders.snapshot(name)
        line = [l for l in pool_holders.report_lines(warn_sec=0.0) if f"pool={name} " in l][0]
        release.set()
        assert (await request).status_code == 200
    assert len(held) == 1
    assert held[0]["route"] == "GET /items/{item_id}", held
    assert "abc123-secret" not in line and "abc123-secret" not in held[0]["route"], "the path value must never reach the log"
    assert "_take_a_connection" in held[0]["from"] and "item" in held[0]["from"], held
    # and where the holder waits NOW: the innermost app frame of its (suspended) await chain, not the outermost coroutine (httpx's client.get)
    assert "_take_a_connection" in held[0]["at"], held


def test_the_app_puts_the_scope_middleware_in_its_stack():
    import app.main as main
    from app.core import pool_holders

    assert any(mw.cls is pool_holders.PoolHolderScopeMiddleware for mw in main.app.user_middleware)


async def test_a_record_handed_out_again_without_a_checkin_leaves_no_stale_connection_ids(watched):
    """SQLAlchemy's GC path terminates a connection without a checkin event and may hand the record out again: the old holder's connection ids must not stay in by_conn
    (codex: memory growth + a later GC line pointing at the wrong place)."""
    from app.core import pool_holders

    name, eng = watched
    reg = pool_holders._pools[name]
    listener = next(f for f in eng.sync_engine.pool.dispatch.checkout if getattr(f, "__name__", "") == "_checkout")

    class _Raw:
        _connection = object()

    async with eng.connect() as conn:
        raw = await conn.get_raw_connection()
        listener(_Raw(), raw._connection_record, None)  # the same record is handed out again; no checkin in between
        live = {cid for h in reg.holders.values() for cid in h.conn_ids}
        assert len(reg.holders) == 1
        assert set(reg.by_conn) == live, "by_conn must hold exactly the live holder's ids: a stale id of the replaced holder is still there, or the live holder's id is missing"
    assert reg.holders == {} and reg.by_conn == {}


def test_the_default_idle_in_transaction_line_is_fifteen_minutes():
    """PO 11-09 (B): 900 s. Five minutes would cut the legitimate request paths that can sit that long (SSE backfill · direct webhook fan-out · request-pool cron); the zombies of 11-09 were hours old."""
    from app.core.config import Settings

    assert Settings.model_fields["db_idle_in_txn_timeout_ms"].default == 900_000


async def test_the_l2_worker_marks_its_advisory_lock_connection_long_lived():
    """The real L2 trigger worker takes its lock connection from the app's worker pool: that holder must carry the mark, and the worker pool must stay quiet with it held."""
    from app.core import pool_holders
    from app.services.l2_trigger_worker import L2TriggerWorker

    worker = L2TriggerWorker(use_advisory_lock=True)
    try:
        await worker._ensure_lock()
        held = pool_holders.snapshot("worker")
        assert len(held) == 1 and held[0]["long"] is True, held
        assert [l for l in pool_holders.report_lines(warn_sec=0.0) if "pool=worker " in l] == [], "the lock connection alone must not make the worker pool talk"
    finally:
        await worker._release_lock()
    assert pool_holders.snapshot("worker") == []


def test_forgetting_a_holder_never_removes_the_entry_of_a_newer_one_with_the_same_id():
    """An id() is reused once its object is freed: the old holder's connection ids may now point at a NEWER holder (codex/Kadir on 5452)."""
    from app.core import pool_holders

    pool = pool_holders._Pool("t4867-own", engine=None)
    old = pool_holders._Holder.__new__(pool_holders._Holder)
    new = pool_holders._Holder.__new__(pool_holders._Holder)
    old.conn_ids, new.conn_ids = (1111, 2222), (1111,)
    pool.by_conn[1111] = new  # the id 1111 was reused by the newer holder
    pool.by_conn[2222] = old
    pool_holders._forget(pool, old)
    assert pool.by_conn == {1111: new}, "only the entries that still point at the old holder may go"


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
    # the finished task object may also be collected, which leaves a DEAD weakref: still a leak, not «no task» (Kadir: leaked= must not read 0 once the task object is gone).
    # Whether CPython collects it in a test is not ours to decide, so the dead weakref is put there by hand.
    reg = pool_holders._pools[name]
    for h in reg.holders.values():
        h.task = lambda: None
    held = pool_holders.snapshot(name)
    assert len(held) == 1 and held[0]["leak"] is True and held[0]["at"] == "task_gone", held
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
            for _ in range(100):
                gc.collect()
                if "non-checked-in connection" in buf.getvalue():
                    break
                await asyncio.sleep(0.05)
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
        h.had_task = False
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
            await asyncio.sleep(3.5)  # sits inside the transaction the first statement opened (line 1.5 s: margin for a slow machine)
            with pytest.raises(Exception) as err:
                await conn.execute(text("select 1"))
            assert "terminat" in str(err.value).lower() or "connection" in str(err.value).lower()
    finally:
        await eng.dispose()


async def test_the_real_lifespan_starts_the_watch_and_cancels_and_awaits_it_at_the_end(monkeypatch):
    """AC7 (Kadir, 5453 delta): deleting the `start_watch` call from the lifespan left every test green, because pytest skips the watch. Here the real lifespan runs with a spy for
    start_watch: it must be called once, its Task must still be running while the app runs, and at the end it must be cancelled AND finished (awaited)."""
    from unittest.mock import AsyncMock, MagicMock

    from app.core import pool_holders
    from app.main import lifespan

    fake_engine = MagicMock()
    fake_engine.dispose = AsyncMock()
    monkeypatch.setattr("app.core.database.engine", fake_engine)

    async def quiet_listen():
        await asyncio.Event().wait()

    monkeypatch.setattr("app.services.pg_pubsub.listen_loop", quiet_listen)
    seen = {"calls": 0, "task": None, "cancelled": False, "finished": False}

    async def fake_watch():
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            seen["cancelled"] = True
            await asyncio.sleep(0.05)  # a slow clean-up: only an AWAITED cancel sees it finish before the lifespan returns
            seen["finished"] = True
            raise

    def spy():
        seen["calls"] += 1
        seen["task"] = asyncio.create_task(fake_watch())
        return seen["task"]

    monkeypatch.setattr(pool_holders, "start_watch", spy)
    async with lifespan(MagicMock()):
        await asyncio.sleep(0.05)
        assert seen["calls"] == 1, "the lifespan must call start_watch exactly once"
        assert seen["task"] is not None and not seen["task"].done()
        assert seen["cancelled"] is False
    assert seen["cancelled"] is True, "the lifespan must cancel the watch task"
    assert seen["finished"] is True and seen["task"].done(), "the lifespan must AWAIT the cancelled task, not just cancel it"


async def test_start_watch_gives_a_task_outside_pytest_and_nothing_under_it_or_when_off(monkeypatch):
    from app.core import pool_holders
    from app.core.config import settings

    monkeypatch.setenv("PYTEST_CURRENT_TEST", "x")
    assert pool_holders.start_watch() is None, "pytest must not get a background loop"
    monkeypatch.delenv("PYTEST_CURRENT_TEST")
    monkeypatch.setattr(settings, "pool_holder_watch_enabled", False)
    assert pool_holders.start_watch() is None, "switched off"
    monkeypatch.setattr(settings, "pool_holder_watch_enabled", True)
    task = pool_holders.start_watch()
    try:
        assert isinstance(task, asyncio.Task) and not task.done()
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


async def test_a_statement_cancelled_in_flight_logs_which_code_was_running(watched, monkeypatch, caplog):
    """prod 11-09: «Exception terminating connection … CancelledError» 19 ms after a POST, no «reset» failure. SQLAlchemy invalidates a connection whose statement is interrupted by a
    CancelledError; the pool watch now says WHICH code was awaiting the database (test frames stand in for «app/» frames)."""
    import logging

    from app.core import pool_holders

    name, eng = watched
    monkeypatch.setattr(pool_holders, "_APP_MARK", "/tests/")
    pool_holders._inval_window.clear()

    async def the_slow_statement_under_test():
        async with eng.connect() as conn:
            await conn.execute(text("select pg_sleep(5)"))

    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    task = asyncio.create_task(the_slow_statement_under_test())
    await asyncio.sleep(0.4)  # the statement is running on the server
    task.cancel("Cancelled via cancel scope 1234 by <Task coro>")
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await _until(lambda: any("connection invalidated" in r.getMessage() for r in caplog.records)), [r.getMessage() for r in caplog.records]
    line = [r.getMessage() for r in caplog.records if "connection invalidated" in r.getMessage()][0]
    assert f"pool={name} " in line and "exc=CancelledError(Cancelled via cancel scope 1234" in line, line
    running = line.split("running when interrupted:", 1)[1]  # NOT the whole line: «checked out at» names the same function and would hide a missing running-stack
    assert "the_slow_statement_under_test" in running, "the line must name the code that was running when the statement was cancelled: " + line


def _installed_invalidate_hook(eng):
    """The listener `install()` registered for the pool's «invalidate» event — calling it is what SQLAlchemy does, so a test through it fails when the registration is removed."""
    return next(f for f in eng.sync_engine.pool.dispatch.invalidate if getattr(f, "__name__", "") == "_invalidate")


async def test_invalidation_lines_come_through_the_installed_hook_and_are_rate_limited(watched, caplog):
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    hook = _installed_invalidate_hook(eng)
    fake = object()
    hook(fake, fake, None)  # a soft invalidation without an exception says nothing
    assert not [r for r in caplog.records if "invalidated" in r.getMessage()]
    for _ in range(50):
        hook(fake, fake, RuntimeError("x"))
    lines = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()]
    assert len(lines) == pool_holders._INVALIDATION_LINES_PER_MIN
    assert "exc=RuntimeError route=-" in lines[0] and "(x)" not in lines[0], "a non-cancellation exception is named by class only: " + lines[0]


async def test_failover_noise_does_not_use_up_the_budget_of_the_cancellations(watched, caplog):
    """codex: pre-ping failures and explicit invalidations fire the same event; 20 of them in a minute must not hide the first real CancelledError."""
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    hook = _installed_invalidate_hook(eng)
    fake = object()
    for _ in range(40):
        hook(fake, fake, ConnectionResetError("failover"))
    hook(fake, fake, asyncio.CancelledError("Cancelled via cancel scope 1 by <Task>"))
    lines = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()]
    assert len(lines) == pool_holders._INVALIDATION_LINES_PER_MIN + 1 and "exc=CancelledError(" in lines[-1], lines[-1]


async def test_a_soft_invalidation_writes_no_line(watched, caplog):
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    async with eng.connect() as conn:
        raw = await conn.get_raw_connection()
        raw.invalidate(soft=True)  # fires «soft_invalidate», not «invalidate»: the connection is only recycled at its next checkout
    assert not [r for r in caplog.records if "invalidated" in r.getMessage()]


async def test_outside_a_database_call_the_line_says_unknown_not_a_misleading_stack(watched, caplog):
    """codex: from a garbage-collector / finalizer context there is no awaited database call; the frames there are whatever triggered the collection."""
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    fake = object()
    pool_holders._log_invalidation(pool_holders._pools[name], fake, fake, asyncio.CancelledError("x"))  # called from the loop's own greenlet, as a finalizer would
    line = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()][0]
    assert "running when interrupted: unknown (not inside a database call" in line, line


def test_the_diagnostic_never_reports_its_own_frames_as_the_running_application():
    from app.core import pool_holders

    chain = pool_holders._checkout_chain(20)  # default «/app/» mark: pool_holders.py itself lives under app/
    assert not [f for f in chain if "pool_holders.py" in f], chain


def test_without_a_greenlet_parent_the_chain_names_the_immediate_caller(monkeypatch):
    """codex (5462): the fallback walk must start at the CALLER of _checkout_chain - dropping it would hide the very code that asked for the connection."""
    from app.core import pool_holders

    monkeypatch.setattr(pool_holders, "_APP_MARK", "/tests/")  # test frames stand in for app frames

    def i_am_the_immediate_caller():
        return pool_holders._checkout_chain(8)

    chain = i_am_the_immediate_caller()
    assert chain and "i_am_the_immediate_caller" in chain[-1], chain  # outermost first: the immediate caller is the last one


async def test_an_invalidation_that_is_not_an_interrupted_statement_carries_no_stack(watched, caplog):
    """codex (5462): a pre-ping failure or an explicit invalidate() inside SQLAlchemy's greenlet must not be reported as «running when interrupted: <checkout code>»."""
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    fake = object()
    pool_holders._log_invalidation(pool_holders._pools[name], fake, fake, ConnectionResetError("failover"))
    line = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()][0]
    assert "running when interrupted: n/a (not an interrupted statement)" in line, line

    async with eng.connect() as conn:  # the same through the real hook, from INSIDE SQLAlchemy's greenlet (an explicit invalidate of a live connection)
        await conn.execute(text("select 1"))
        await conn.invalidate(ConnectionResetError("failover"))
    real = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()][-1]
    assert "running when interrupted: n/a (not an interrupted statement)" in real, real


async def test_a_huge_cancellation_reason_is_cut_before_it_is_processed(watched, monkeypatch):
    """codex (5462): the cap must come BEFORE split/join - a megabytes-long Task.cancel(msg) must not be walked whole inside the pool machinery."""
    from app.core import db_error_redaction, pool_holders

    seen: list[int] = []

    class Spy(str):
        def split(self, *a, **k):  # only reached if the code splits the WHOLE text
            seen.append(len(self))
            return super().split(*a, **k)

    monkeypatch.setattr(db_error_redaction, "safe_exception_text", lambda exc: Spy("word " * 200_000))
    name, eng = watched
    pool_holders._inval_window.clear()
    fake = object()
    pool_holders._log_invalidation(pool_holders._pools[name], fake, fake, asyncio.CancelledError("x"))
    assert not seen or max(seen) <= pool_holders._REASON_CHARS * 8, f"split() ran on a text of {max(seen)} characters"


async def test_a_cancellation_reason_is_one_line_and_cut(watched, caplog):
    import logging

    from app.core import pool_holders

    name, eng = watched
    pool_holders._inval_window.clear()
    caplog.set_level(logging.WARNING, logger="app.pool_holders")
    fake = object()
    pool_holders._log_invalidation(pool_holders._pools[name], fake, fake, asyncio.CancelledError("A" * 400 + "\nsecond line"))
    line = [r.getMessage() for r in caplog.records if "invalidated" in r.getMessage()][0]
    reason = line.split("exc=CancelledError(", 1)[1].split(") route=", 1)[0]
    assert reason == "A" * pool_holders._REASON_CHARS, reason


def test_the_rate_limit_table_does_not_grow_for_ever_with_dynamic_pool_names():
    import time

    from app.core import pool_holders

    pool_holders._inval_window.clear()
    old = time.monotonic() - 3600
    for i in range(100):
        pool_holders._inval_window[f"gone-{i}:other"] = [old]
    assert pool_holders._invalidation_budget("fresh", False, time.monotonic()) is True
    assert len(pool_holders._inval_window) <= 2, len(pool_holders._inval_window)


async def test_this_modules_own_frames_are_never_reported_as_the_app(monkeypatch):
    """codex (5462): the instrumentation's own frames (_checkout_chain / _log_invalidation live under app/ too) must never be named as «the code that was running». A frame whose
    file IS pool_holders.py — made here by compiling a line under that file name — is left out, while a frame of any other app file is still named."""
    import sys

    from app.core import pool_holders

    monkeypatch.setattr(pool_holders, "_APP_MARK", "/app/")
    ns: dict = {}
    exec(compile("import sys\nframe = sys._getframe()\n", pool_holders.__file__, "exec"), ns)
    assert pool_holders.__file__.rfind("/app/") >= 0, "the premise: this module lives under /app/"
    assert pool_holders._app_frame_text(ns["frame"]) is None, "the module's own frame was reported as an app frame"
    other = {}
    exec(compile("import sys\nframe = sys._getframe()\n", pool_holders.__file__.replace("pool_holders.py", "some_other_service.py"), "exec"), other)
    assert pool_holders._app_frame_text(other["frame"]) is not None, "any OTHER app file must still be named"
    assert sys is not None
