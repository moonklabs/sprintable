"""story #4867 ⓕ ⓓ — background work that takes a REQUEST-pool place per piece is let through a few at a time.

Real Postgres (PARITY_DATABASE_URL). The tests make THEIR OWN pool of PROD's size (20 + 10) and put it in place of the app's session factory (`prod_pool` below): on the default test pool
(3 + 1) a cap of 4 could not be told from no cap at all, and a test that leans on the process's DB_POOL_SIZE proves nothing on a runner that sets a small one. Same proof on every runner.

ⓕ an org-wide event (presence) with 100 members → 100 `pg_notify` → at most `pg_notify_max_concurrent` pool places at once, and all 100 still arrive (nothing dropped)
ⓓ 60 AU metering tasks → at most `au_metering_max_concurrent` pool places at once, and all 60 still run
the gate itself: one semaphore per event loop · limit ≤ 0 = off · the defaults
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from sqlalchemy import text

_REAL_DB_URL = os.environ.get("PARITY_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres needed (PARITY/ALEMBIC_DATABASE_URL)"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _gates_closed():
    from app.core import bounded_gate

    bounded_gate.reset_all()  # another test's lifespan may have opened them (shutdown)
    yield


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")


@pytest.fixture
async def prod_pool(monkeypatch):
    """A pool of PROD's size (20 + 10) made by the test, standing in for the app's own session factory for the duration — the code under test (`pg_notify` ·
    `tool_call_recording`) looks `async_session_factory` up in app.core.database when it runs, so it takes its places from THIS pool."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.core.database as database

    eng = create_async_engine(_async_url(), pool_size=20, max_overflow=10, pool_pre_ping=True)
    factory = async_sessionmaker(eng, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session_factory", factory)
    assert eng.pool.size() + eng.pool._max_overflow == 30
    yield eng, factory
    await eng.dispose()


async def _until(pred, timeout: float = 15.0, step: float = 0.02) -> bool:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(step)
    return pred()


class _Peak:
    """The highest number of request-pool places in use at one moment while it ran."""

    def __init__(self, engine) -> None:
        self.engine, self.peak, self._stop, self._task = engine, 0, False, None

    async def __aenter__(self):
        async def run():
            while not self._stop:
                self.peak = max(self.peak, self.engine.pool.checkedout())
                await asyncio.sleep(0.0005)

        self._task = asyncio.create_task(run())
        return self

    async def __aexit__(self, *exc):
        self._stop = True
        await self._task


async def test_an_org_wide_event_takes_at_most_the_gate_of_request_pool_places_and_loses_nothing(prod_pool):
    import asyncpg

    from app.core.config import settings
    from app.routers.events import push_to_org_members
    from app.services import pg_pubsub

    engine, factory = prod_pool
    dsn = (_REAL_DB_URL or "").replace("postgresql+psycopg2://", "postgresql://").replace("postgresql+asyncpg://", "postgresql://")
    received: list[str] = []
    listener = await asyncpg.connect(dsn)
    try:
        await listener.add_listener(pg_pubsub._CHANNEL, lambda conn, pid, channel, payload: received.append(payload))
        ids = {str(uuid.uuid4()) for _ in range(100)}
        # warm the pool: connection creation is not what is measured
        await asyncio.gather(*[_ping(factory) for _ in range(30)])
        async with _Peak(engine) as peak:
            await push_to_org_members("org-x", "presence", {}, member_ids=ids)
            assert await _until(lambda: not pg_pubsub._background_tasks), "the fire-and-forget notifies did not finish"
        assert await _until(lambda: len(received) >= 100), f"only {len(received)} of 100 notifications arrived — nothing may be dropped"
    finally:
        await listener.close()
    assert peak.peak <= settings.pg_notify_max_concurrent, f"{peak.peak} request-pool places at once (gate {settings.pg_notify_max_concurrent})"
    assert len(received) == 100


async def _ping(factory) -> None:
    async with factory() as s:
        await s.execute(text("select 1"))


async def test_au_metering_tasks_take_at_most_the_gate_of_request_pool_places_and_none_is_lost(prod_pool, monkeypatch):
    from app.core.config import settings
    from app.services import au_metering

    engine, async_session_factory = prod_pool
    ran: list[int] = []

    async def stub_record(org_id, delta):  # holds a pool place for a moment, like the real insert + advisory lock
        async with async_session_factory() as s:
            await s.execute(text("select pg_sleep(0.03)"))
        ran.append(delta)

    monkeypatch.setattr(au_metering, "record_au_usage", stub_record)
    await asyncio.gather(*[_ping(async_session_factory) for _ in range(30)])
    org = uuid.uuid4()
    async with _Peak(engine) as peak:
        await asyncio.gather(*[au_metering._record_au_usage_safe(org, i + 1) for i in range(60)])
    assert peak.peak <= settings.au_metering_max_concurrent, f"{peak.peak} request-pool places at once (gate {settings.au_metering_max_concurrent})"
    assert sorted(ran) == list(range(1, 61)), "every delta must still be written"


async def test_tool_call_recording_tasks_take_at_most_the_gate_of_request_pool_places_and_none_is_lost(prod_pool, monkeypatch):
    from app.core.config import settings
    from app.services import tool_call_recording as tcr

    engine, factory = prod_pool
    ran: list[int] = []

    async def stub_insert(session, **kw):  # holds the session's pool place for a moment, like attribution + insert
        await session.execute(text("select pg_sleep(0.03)"))
        ran.append(kw["n"])

    monkeypatch.setattr(tcr, "attribute_and_insert", stub_insert)
    await asyncio.gather(*[_ping(factory) for _ in range(30)])
    async with _Peak(engine) as peak:
        await asyncio.gather(*[tcr._record_tool_call_safe(n=i + 1) for i in range(60)])
    assert peak.peak <= settings.tool_call_recording_max_concurrent, f"{peak.peak} request-pool places at once (gate {settings.tool_call_recording_max_concurrent})"
    assert sorted(ran) == list(range(1, 61)), "every recording must still be written"
