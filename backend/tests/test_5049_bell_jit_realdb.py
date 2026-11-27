"""story 5049 (bell cost) — the bell's three statements (unread-count · list · «read all») run with `SET LOCAL jit = off`. Real Postgres, real routes.

Why: the planner prices those statements far above `jit_above_cost` (100,000 — every row of the recipient is charged every sub-plan of the hiding and room rules; measured 91k–31M on 16k–1M `events` rows), so with `jit = on` (the
Postgres default; on in dev) PostgreSQL compiled them with LLVM on EVERY call: on dev the unread-count was ~84 ms of work and ~2.2 s of compiling, and the LLVM memory (outside the memory contexts of the backend) took a backend to its
death four times in 15 minutes. `SET LOCAL` is in force until the transaction ends (commit or rollback), then the connection returns to the pool as it was. The database-wide setting stays the operator's.

  01 the three statements are each preceded by `SET LOCAL jit = off` (count · list · read-all), right before the bell's own statement
  02 `SET LOCAL jit = off` does not leak: on a one-connection pool the next transaction on the SAME connection sees `jit = on` again, after a commit and after a rollback
"""
from __future__ import annotations

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from tests.test_4752_account_delete_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _async_url,
    _dispose_global_engine_after_test,
    _no_rate_limit,
)
from tests.test_5032_channel_residual_access_realdb import _H, _add_person, _close, _owner_and_channel, _world

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def test_01_the_three_statements_are_each_preceded_by_set_local_jit_off():
    engine, w = await _world()
    try:
        org, ot, pid, _chan = await _owner_and_channel(w, "Jit")
        _uid, _a, ta = await _add_person(w, org, ot, pid)
        seen: list[str] = []

        def hook(conn, cursor, statement, params, context, executemany):
            if "SET LOCAL jit" in statement or ("events" in statement and (statement.lstrip().startswith(("SELECT count", "UPDATE events")) or "ORDER BY events.created_at DESC" in statement)):
                seen.append("JIT_OFF" if "SET LOCAL jit = off" in statement else ("count" if "count(*)" in statement else ("read_all" if statement.lstrip().startswith("UPDATE") else "list")))

        event.listen(engine.sync_engine, "before_cursor_execute", hook)
        try:
            for method, url in (("get", "/api/v2/event-notifications/unread-count"), ("get", "/api/v2/event-notifications?limit=5"), ("patch", "/api/v2/event-notifications/read-all")):
                seen.clear()
                assert (await getattr(w.client, method)(url, headers=_H(ta))).status_code == 200
                kinds = [k for k in seen if k != "JIT_OFF"]
                assert kinds, (url, seen)
                first = seen.index(kinds[0])
                assert first > 0 and seen[first - 1] == "JIT_OFF", f"{url}: `SET LOCAL jit = off` must come right before the bell's statement: {seen}"
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", hook)
    finally:
        await _close(engine, w)


async def test_02_set_local_jit_off_does_not_leak_to_the_next_transaction_on_the_same_connection():
    from app.routers.event_notifications import _jit_off

    engine = create_async_engine(_async_url(), pool_size=1, max_overflow=0)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        for ending in ("commit", "rollback"):
            async with Session() as s:
                pid = (await s.execute(text("SELECT pg_backend_pid()"))).scalar_one()
                await _jit_off(s)
                assert (await s.execute(text("SHOW jit"))).scalar_one() == "off"
                await getattr(s, ending)()
            async with Session() as s2:  # the pool of one hands the SAME connection back
                assert (await s2.execute(text("SELECT pg_backend_pid()"))).scalar_one() == pid
                assert (await s2.execute(text("SHOW jit"))).scalar_one() == "on", f"jit stayed off after a {ending}"
    finally:
        await engine.dispose()
