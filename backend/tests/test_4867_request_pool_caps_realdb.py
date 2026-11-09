"""story #4867 ⓕ ⓓ — background work that takes a REQUEST-pool place per piece is let through a few at a time.

Real Postgres (PARITY_DATABASE_URL + DATABASE_URL for the app's own engine) with the PROD pool (DB_POOL_SIZE=20 · DB_MAX_OVERFLOW=10): on the default test pool (3+1) a cap of 4 could not be told from
no cap at all, so the tests refuse to run on a pool that small.

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
_APP_DB = os.environ.get("DATABASE_URL")
pytestmark = [pytest.mark.skipif(not (_REAL_DB_URL and _APP_DB), reason="real Postgres + DATABASE_URL for the app engine needed"), pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _prod_sized_pool(engine) -> int:
    cap = engine.pool.size() + max(int(getattr(engine.pool, "_max_overflow", 0)), 0)
    assert cap >= 30, f"run with DB_POOL_SIZE=20 DB_MAX_OVERFLOW=10 (this pool has {cap} places: a cap of 4 would prove nothing)"
    return cap


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


async def test_an_org_wide_event_takes_at_most_the_gate_of_request_pool_places_and_loses_nothing():
    import asyncpg

    from app.core.config import settings
    from app.core.database import engine
    from app.routers.events import push_to_org_members
    from app.services import pg_pubsub

    _prod_sized_pool(engine)
    dsn = (_REAL_DB_URL or "").replace("postgresql+psycopg2://", "postgresql://").replace("postgresql+asyncpg://", "postgresql://")
    received: list[str] = []
    listener = await asyncpg.connect(dsn)
    try:
        await listener.add_listener(pg_pubsub._CHANNEL, lambda conn, pid, channel, payload: received.append(payload))
        ids = {str(uuid.uuid4()) for _ in range(100)}
        # warm the pool: connection creation is not what is measured
        await asyncio.gather(*[_ping() for _ in range(30)])
        async with _Peak(engine) as peak:
            await push_to_org_members("org-x", "presence", {}, member_ids=ids)
            assert await _until(lambda: not pg_pubsub._background_tasks), "the fire-and-forget notifies did not finish"
        assert await _until(lambda: len(received) >= 100), f"only {len(received)} of 100 notifications arrived — nothing may be dropped"
    finally:
        await listener.close()
    assert peak.peak <= settings.pg_notify_max_concurrent, f"{peak.peak} request-pool places at once (gate {settings.pg_notify_max_concurrent})"
    assert len(received) == 100


async def _ping() -> None:
    from app.core.database import async_session_factory

    async with async_session_factory() as s:
        await s.execute(text("select 1"))


async def test_au_metering_tasks_take_at_most_the_gate_of_request_pool_places_and_none_is_lost(monkeypatch):
    from app.core.config import settings
    from app.core.database import async_session_factory, engine
    from app.services import au_metering

    _prod_sized_pool(engine)
    ran: list[int] = []

    async def stub_record(org_id, delta):  # holds a pool place for a moment, like the real insert + advisory lock
        async with async_session_factory() as s:
            await s.execute(text("select pg_sleep(0.03)"))
        ran.append(delta)

    monkeypatch.setattr(au_metering, "record_au_usage", stub_record)
    await asyncio.gather(*[_ping() for _ in range(30)])
    org = uuid.uuid4()
    async with _Peak(engine) as peak:
        await asyncio.gather(*[au_metering._record_au_usage_safe(org, i + 1) for i in range(60)])
    assert peak.peak <= settings.au_metering_max_concurrent, f"{peak.peak} request-pool places at once (gate {settings.au_metering_max_concurrent})"
    assert sorted(ran) == list(range(1, 61)), "every delta must still be written"


def test_the_gate_is_one_semaphore_per_event_loop_and_off_at_zero():
    from app.core.bounded_gate import LoopGate

    limit = {"n": 2}
    gate = LoopGate(lambda: limit["n"])

    async def sem_id():
        return id(gate._semaphore())

    a = asyncio.run(sem_id())
    b = asyncio.run(sem_id())
    assert isinstance(a, int) and isinstance(b, int)  # two loops, one gate: the second loop must not hit «bound to a different event loop»
    # limit 2 really limits to 2 at once
    async def at_once():
        active, peak = 0, 0

        async def piece():
            nonlocal active, peak
            async with gate.slot():
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1

        await asyncio.gather(*[piece() for _ in range(12)])
        return peak

    assert asyncio.run(at_once()) == 2
    # 0 = off: all twelve run at once
    limit["n"] = 0
    assert asyncio.run(at_once()) == 12


def test_the_defaults_are_the_agreed_gates():
    from app.core.config import Settings

    assert Settings.model_fields["pg_notify_max_concurrent"].default == 4
    assert Settings.model_fields["au_metering_max_concurrent"].default == 2
