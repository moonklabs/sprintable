"""story #4864 AC1/AC2 — a request cancelled in the middle of a database statement must not leave a request-pool place behind.

Root cause (prod, found and reproduced in #4864): an SSE StreamingResponse whose client leaves is cancelled by an anyio cancel scope
(level-triggered). If that lands inside a statement, SQLAlchemy invalidates the connection -> `AsyncAdapt_terminate.terminate` re-raises
the CancelledError out of `_ConnectionRecord.invalidate`/`_finalize_fairy` BEFORE the record is given back. On SQLAlchemy <= 2.0.55 the
pool place is then lost until the garbage collector reports "non-checked-in connection" (or, when the fairy stays referenced, for good) —
30 places gone with 12 connections on the database side. Fixed upstream in 2.0.56 (sqlalchemy issue #13699): the record is returned when a
non-Exception (a cancellation) leaves `_finalize_fairy`.

Real Postgres (PARITY_DATABASE_URL / ALEMBIC_DATABASE_URL); only `pg_sleep`, no schema needed.

① the real thing: anyio cancel scopes cancelling 30 requests mid-`pg_sleep` on a prod-sized pool (20+10) -> 0 places held, 0 GC «non-checked-in» lines, the pool still serves 30 at once
② the version guard (no database needed): the installed SQLAlchemy carries the #13699 fix, so a downgrade (or a lock drift) fails here and not in prod
"""
from __future__ import annotations

import asyncio
import gc
import logging
import os
import re

import anyio
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

_REAL_DB_URL = os.environ.get("PARITY_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL")
_needs_db = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")


def test_the_installed_sqlalchemy_carries_the_cancellation_fix_13699():
    """Pure: no database. The fix is a RELEASE fact (first in 2.0.56), not a source-text fact: the behaviour itself is pinned by the
    real-database test below, which fails on its own if a later release regresses it. This guard only fails fast, and loudly, on a downgrade
    or lock drift when no database is at hand."""
    import sqlalchemy

    m = re.match(r"(\d+)\.(\d+)\.(\d+)", sqlalchemy.__version__)
    assert m, f"unparseable SQLAlchemy version {sqlalchemy.__version__!r}"
    assert tuple(int(p) for p in m.groups()) >= (2, 0, 56), (
        f"SQLAlchemy {sqlalchemy.__version__} returns no pool place when a cancellation leaves _finalize_fairy — "
        "story 4864: stay on >=2.0.56 (sqlalchemy issue #13699) or carry an equivalent patch"
    )


@_needs_db
@pytest.mark.anyio
@pytest.mark.parametrize("shape", ["session_per_turn", "session_held"])
async def test_requests_cancelled_inside_a_statement_give_every_pool_place_back(shape, caplog):
    """The SSE shape from prod: a loop of short statements (a wake/rescan) under a cancel scope that fires while one is in flight.
    A single long statement does NOT show the leak (checked: 0 lost on 2.0.49) — the loop is what puts the cancellation inside invalidate()."""
    import random

    from sqlalchemy.ext.asyncio import async_sessionmaker

    eng = create_async_engine(_async_url(), pool_size=20, max_overflow=10, pool_timeout=5, pool_pre_ping=True)
    sf = async_sessionmaker(eng, expire_on_commit=False)
    caplog.set_level(logging.DEBUG, logger="sqlalchemy.pool")
    total, rounds = 30, 4
    rng = random.Random(4864)

    async def request():
        with anyio.move_on_after(0.3 + rng.random() * 0.2) as scope:
            if shape == "session_per_turn":
                while True:
                    async with sf() as s:
                        await s.execute(text("select pg_sleep(0.02)"))
            else:
                async with sf() as s:
                    while True:
                        await s.execute(text("select pg_sleep(0.02)"))
                        await s.commit()
        assert scope.cancel_called

    held: list = []  # connections taken by the final probe: closed in `finally` whatever happened
    try:
        for _ in range(rounds):
            async with anyio.create_task_group() as tg:
                for _ in range(total):
                    tg.start_soon(request)
            # NO gc.collect() before this line: the garbage collector is what used to «find» lost places later and hide the leak
            assert eng.pool.checkedout() == 0, f"{eng.pool.checkedout()} pool places still held after {total} cancellations"

        gc.collect()
        await asyncio.sleep(0.2)
        assert eng.pool.checkedout() == 0
        gc_lines = [r for r in caplog.records if "non-checked-in connection" in r.getMessage()]
        assert not gc_lines, f"{len(gc_lines)} places were only found by the garbage collector"

        # and the pool really serves its full size again: 30 at once, each answered
        answers: list = []

        async def ping():
            conn = await eng.connect()
            held.append(conn)
            answers.append((await conn.execute(text("select 1"))).scalar_one())

        with anyio.fail_after(15):
            async with anyio.create_task_group() as tg:  # one failure cancels its siblings: none outlives the test
                for _ in range(total):
                    tg.start_soon(ping)
        assert answers == [1] * total
        for c in held:
            await c.close()
        held.clear()
        assert eng.pool.checkedout() == 0
    finally:
        for c in held:
            await asyncio.shield(c.close())
        gc.collect()  # a place lost by a failing run has no database connection behind it; let the collector drop what the pool no longer owns
        await eng.dispose()
