"""story 4791 (INFRA-DIET ⑥) — the SSE lease on Postgres rows, for when Redis is off.

The desktop relay's «one receiver per agent, take-over» contract was kept by the Redis lease only. With Redis off and two backend instances the lease was each
instance's own memory: receiver A (instance 1) and receiver B (instance 2) did not know of each other and both read the same command. Now `sse_lease` answers from
`sse_leases` / `sse_lease_taken` (`services/sse_lease_pg.py`) when Redis is off, for the `perkey:<agent>` scopes.

Real Postgres. Two instances are two sets of process memory — `_agent_connections` and `_receiver_streams` of agent_gateway — over ONE database, which is
exactly what two Cloud Run instances share. The one-receiver rules themselves (409 · hand-over · take-over · take-back · heartbeat) run on this path in
`test_4676_setup_key_one_receiver_realdb.py` (its `postgres` lease path). The last test sends a wake through a REAL NOTIFY to a real LISTEN connection.
"""
from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import patch

import pytest

from tests.test_1994_backlink_api_realdb import _session_factory
from tests.test_4676_setup_key_one_receiver_realdb import (
    _REAL_DB_URL,
    R1,
    R2,
    TAKEN_OVER_FRAME,
    _drain,
    _refused,
    _Req,
    _world,
)

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """the app's own engine pools connections of the loop it was used in; each test has its own loop — a leftover pooled connection makes the next
    use fail with «attached to a different loop» (pg_notify swallows that and logs). Same remedy as test_1994's."""
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture
def pg_lease():
    """Redis lease off, Postgres lease on (the dev stack once Redis is shut down)"""
    from app.services import sse_lease

    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", False), \
         patch.object(sse_lease.settings, "sse_lease_pg_enabled", True):
        yield


@asynccontextmanager
async def _db():
    """a factory of real sessions swapped in for the app's, and the rows these tests made removed afterwards"""
    from sqlalchemy import text

    engine, Session = await _session_factory()
    scopes: list[str] = []

    @asynccontextmanager
    async def _factory():
        async with Session() as s:
            yield s

    def scope() -> str:
        sc = f"perkey:{uuid.uuid4()}"
        scopes.append(sc)
        return sc

    try:
        with patch("app.core.database.async_session_factory", _factory):
            yield Session, scope
    finally:
        async with Session() as s:
            for sc in scopes:
                await s.execute(text("DELETE FROM sse_leases WHERE scope = :s"), {"s": sc})
                await s.execute(text("DELETE FROM sse_lease_taken WHERE scope = :s"), {"s": sc})
            await s.commit()
        await engine.dispose()


async def _move_expiry(Session, scope: str, seconds: float, table: str = "sse_leases") -> None:
    """put every row of the scope's lapse time `seconds` from now (negative = already lapsed) — the clock of the test is the database's, as the app's"""
    from sqlalchemy import text

    async with Session() as s:
        await s.execute(text(f"UPDATE {table} SET expires_at = now() + make_interval(secs => :t) WHERE scope = :s"), {"t": seconds, "s": scope})
        await s.commit()


async def _rows(Session, scope: str, table: str = "sse_leases") -> int:
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(f"SELECT count(*) FROM {table} WHERE scope = :s"), {"s": scope})).scalar_one()


# ───────────────────────────── the lease itself ─────────────────────────────


async def test_twenty_instances_asking_at_once_for_three_places_get_exactly_three(pg_lease):
    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        answers = await asyncio.gather(*[sse_lease.acquire(scope, 3, f"conn-{i}") for i in range(20)])
        assert answers.count(True) == 3 and answers.count(False) == 17 and None not in answers
        assert await sse_lease.count(scope) == 3


async def test_a_member_that_holds_a_place_keeps_it_at_the_limit_and_a_lapsed_place_is_free(pg_lease):
    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        assert await sse_lease.acquire(scope, 1, "rcv:a") is True
        assert await sse_lease.acquire(scope, 1, "rcv:a") is True  # its own reconnect (4509): a refresh, not a second place
        assert await sse_lease.acquire(scope, 1, "rcv:b") is False
        await _move_expiry(Session, scope, -1)  # rcv:a lapsed without a release (a killed instance)
        assert await sse_lease.acquire(scope, 1, "rcv:b") is True
        assert await sse_lease.members(scope) == ["rcv:b"]  # the lapsed row was evicted, not counted


async def test_members_release_refresh_and_count(pg_lease):
    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        await sse_lease.acquire(scope, 5, "rcv:a")
        await sse_lease.acquire(scope, 5, "rcv:b")
        assert sorted(await sse_lease.members(scope)) == ["rcv:a", "rcv:b"]
        await sse_lease.release(scope, "rcv:a")
        assert await sse_lease.members(scope) == ["rcv:b"]
        assert await sse_lease.count(scope) == 1
        # a refresh puts a live stream's place back, like the Redis ZADD (the caller guards a taken-over stream with the mark, not here)
        await sse_lease.refresh(scope, "rcv:a")
        assert sorted(await sse_lease.members(scope)) == ["rcv:a", "rcv:b"]
        await _move_expiry(Session, scope, -1)
        assert await sse_lease.members(scope) == [] and await sse_lease.count(scope) == 0


async def test_a_refresh_pushes_a_live_streams_lapse_time_forward(pg_lease):
    from sqlalchemy import text

    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        await sse_lease.acquire(scope, 5, "rcv:a")
        await _move_expiry(Session, scope, 5)  # the stream missed beats: 5 s from lapsing
        await sse_lease.refresh(scope, "rcv:a")  # its next heartbeat
        async with Session() as s:
            remaining = (await s.execute(text("SELECT EXTRACT(EPOCH FROM (expires_at - now())) FROM sse_leases WHERE scope = :s AND member = 'rcv:a'"), {"s": scope})).scalar_one()
        assert float(remaining) > 60, "renewed to a fresh lease time (90 s), not left at 5 s"
        assert await _rows(Session, scope) == 1  # the same row, not a second one


async def test_the_take_over_mark_is_read_by_another_instance_and_cleared_only_by_its_own_taker(pg_lease):
    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        assert await sse_lease.taken_by(scope) is None
        await sse_lease.mark_taken(scope, "rcv:b")
        assert await sse_lease.taken_by(scope) == "rcv:b"
        await sse_lease.mark_taken(scope, "rcv:c")  # a later taker
        await sse_lease.clear_taken(scope, "rcv:b")  # the first taker's stream ends: only ITS mark may go (Kadir 4676 ①)
        assert await sse_lease.taken_by(scope) == "rcv:c"
        await sse_lease.clear_taken(scope, "rcv:c")
        assert await sse_lease.taken_by(scope) is None
        await sse_lease.mark_taken(scope, "rcv:d")
        await _move_expiry(Session, scope, -1, table="sse_lease_taken")  # a taker that died: the mark lapses by itself
        assert await sse_lease.taken_by(scope) is None


async def test_retry_after_is_only_trusted_for_a_lease_that_has_already_missed_a_beat(pg_lease):
    import time

    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        scope = new_scope()
        assert await sse_lease.earliest_expiry(scope) is None  # nothing live
        await sse_lease.acquire(scope, 5, "rcv:a")
        assert await sse_lease.earliest_expiry(scope) is None  # just refreshed: a live-full scope tells nothing (2582)
        await _move_expiry(Session, scope, 10)  # missed beats: the soonest it will lapse is a real answer
        t = await sse_lease.earliest_expiry(scope)
        assert t is not None and 5 < t - time.time() <= 11


async def test_a_database_that_cannot_answer_fails_open_like_a_redis_that_cannot(pg_lease):
    from app.services import sse_lease

    class _Boom:
        def __call__(self):
            raise RuntimeError("database down")

    scope = f"perkey:{uuid.uuid4()}"
    with patch("app.core.database.async_session_factory", _Boom()):
        assert await sse_lease.acquire(scope, 1, "rcv:a") is None  # the caller counts in-process, as with Redis down
        assert await sse_lease.members(scope) is None
        assert await sse_lease.count(scope) is None
        assert await sse_lease.taken_by(scope) is None
        assert await sse_lease.earliest_expiry(scope) is None
        await sse_lease.refresh(scope, "rcv:a")  # no-ops, no raise
        await sse_lease.release(scope, "rcv:a")
        await sse_lease.mark_taken(scope, "rcv:a")
        await sse_lease.clear_taken(scope, "rcv:a")


async def test_only_the_receiver_scopes_use_the_database_and_the_flag_turns_it_off(pg_lease):
    from app.services import sse_lease

    async with _db() as (Session, new_scope):
        for other in ("events_global", "agent_global", f"desktop:{uuid.uuid4()}"):  # the global caps and the device count stay in-process (a limit of 4791)
            assert await sse_lease.acquire(other, 1, "conn-1") is None
            assert await sse_lease.members(other) is None
        scope = new_scope()
        with patch.object(sse_lease.settings, "sse_lease_pg_enabled", False):
            assert await sse_lease.acquire(scope, 1, "rcv:a") is None  # the rollback switch: the old in-process behaviour
        assert await _rows(Session, scope) == 0


async def test_with_the_redis_lease_on_nothing_is_written_to_the_database():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    pytest.importorskip("lupa")
    from app.services import sse_lease

    client = aioredis.FakeRedis(server=aioredis.FakeServer(), decode_responses=True)
    async with _db() as (Session, new_scope):
        scope = new_scope()
        with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
             patch.object(sse_lease.settings, "redis_url", "redis://fake"), \
             patch("app.services.redis_shared.get_client", return_value=client):
            assert await sse_lease.acquire(scope, 1, "rcv:a") is True
            await sse_lease.mark_taken(scope, "rcv:a")
            assert await sse_lease.members(scope) == ["rcv:a"]
        assert await _rows(Session, scope) == 0 and await _rows(Session, scope, "sse_lease_taken") == 0  # Redis is the main path, as before


# ─────────────────── two backend instances, one receiver (AC1) ───────────────────


@contextmanager
def _instance(gw, memory):
    """run as one backend instance: its own `_agent_connections` and `_receiver_streams` (what a second Cloud Run instance does not share)"""
    conns, receivers = memory
    with patch.object(gw, "_agent_connections", conns), patch.object(gw, "_receiver_streams", receivers):
        yield


def _new_instance():
    return defaultdict(set), {}


async def test_a_receiver_on_another_instance_is_refused_with_409_and_only_one_receives(pg_lease):
    async with _world(setup=True, limit=5) as (gw, auth, agent):
        one, two = _new_instance(), _new_instance()
        with _instance(gw, one):
            first = await gw.agent_stream(request=_Req(R1), auth=auth)
        with _instance(gw, two):
            refused = await _refused(gw, auth, _Req(R2))  # instance 2 has no memory of R1 — only the lease does
            assert refused.status_code == 409 and refused.detail["code"] == "another_receiver"
            assert (await _refused(gw, auth, _Req(None))).status_code == 409  # an old app without the header: the same rule
        with _instance(gw, one):
            await first.body_iterator.aclose()


async def test_without_the_database_lease_two_instances_both_receive_the_gap_this_story_closes(pg_lease):
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        one, two = _new_instance(), _new_instance()
        with patch.object(sse_lease.settings, "sse_lease_pg_enabled", False):
            with _instance(gw, one):
                first = await gw.agent_stream(request=_Req(R1), auth=auth)
            with _instance(gw, two):
                second = await gw.agent_stream(request=_Req(R2), auth=auth)  # let in: nobody knows of R1 — two places read the same commands
            with _instance(gw, one):
                await first.body_iterator.aclose()
            with _instance(gw, two):
                await second.body_iterator.aclose()


async def test_a_take_over_on_another_instance_ends_the_old_receiver_on_its_heartbeat(pg_lease):
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        scope = f"perkey:{agent}"
        one, two = _new_instance(), _new_instance()
        with _instance(gw, one):
            first = await gw.agent_stream(request=_Req(R1), auth=auth)
        with _instance(gw, two):
            second = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)  # a person's [여기서 받기] reached instance 2
            assert gw._receiver_streams.get((agent, R1)) is None  # instance 2 had nothing of R1 to end by itself
        assert await sse_lease.members(scope) == [f"rcv:{R2}"]
        with _instance(gw, one):
            old = await _drain(first.body_iterator)  # R1's stream is on instance 1: it ends because its heartbeat reads the mark
            assert old[-1] == TAKEN_OVER_FRAME
        assert await sse_lease.members(scope) == [f"rcv:{R2}"], "the old receiver's end and refresh did not put it back: ONE place receives"
        with _instance(gw, two):
            again = await _refused(gw, auth, _Req(R1))  # the displaced install's reconnect is now the refused one
            assert again.status_code == 409
            await anext(second.body_iterator)
            await second.body_iterator.aclose()
        assert await sse_lease.taken_by(scope) is None, "the taker's own end cleared its mark"


# ───────────────────────── the wake over a real NOTIFY (AC2) ─────────────────────────


async def test_a_wake_from_instance_one_reaches_the_stream_on_instance_two_through_postgres(caplog):
    """Redis fan-out off: instance 1's `wake_agent` sends NOTIFY; instance 2's LISTEN connection hands the stream's queue a signal that carries the
    `__wake__` marker, so the stream loop rescans without a reconnect. Before the fix the marker was only in the event type, which the receiving side drops."""
    from app.core.config import settings
    from app.routers import agent_gateway as gw
    from app.routers import events as events_mod
    from app.services import pg_pubsub, realtime_readiness

    agent_id = str(uuid.uuid4())
    sent: list = []
    with patch.object(settings, "fanout_wake_redis_enabled", False), \
         patch.object(pg_pubsub, "fire_and_forget", side_effect=lambda coro: sent.append(coro)):
        gw.wake_agent(agent_id, 7)  # instance 1 (nothing of this agent is open here: no local queue gets it)
    assert len(sent) == 1

    saved = (realtime_readiness._connected, realtime_readiness._disconnected_since, realtime_readiness._last_error)
    realtime_readiness._connected = False
    listener = asyncio.create_task(pg_pubsub.listen_loop())  # instance 2's LISTEN connection
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    try:
        for _ in range(200):
            if realtime_readiness._connected:
                break
            await asyncio.sleep(0.05)
        assert realtime_readiness._connected, "the LISTEN connection came up"
        events_mod._agent_connections[agent_id].add(q)  # the desktop stream on instance 2
        # who sent it: the payload is built (with this id) before the coroutine's first await, so the id is patched only for that step — the
        # listener compares against the real id whenever the notification arrives, even while the sender is still waiting for its commit
        with patch.object(pg_pubsub, "INSTANCE_ID", "instance-1-of-test"):
            publish = asyncio.ensure_future(sent[0])
            await asyncio.sleep(0)
        await publish
        try:
            signal = await asyncio.wait_for(q.get(), 10)
        except asyncio.TimeoutError:
            failed = [r.getMessage() for r in caplog.records if "pg_notify failed" in r.getMessage() or "pg_listen" in r.getMessage()]
            raise AssertionError(f"no signal reached instance 2 within 10 s; pubsub log: {failed}") from None
        assert signal.get("__wake__") is True and signal.get("seq") == 7
    finally:
        listener.cancel()
        await asyncio.gather(listener, return_exceptions=True)
        events_mod._agent_connections.pop(agent_id, None)
        realtime_readiness._connected, realtime_readiness._disconnected_since, realtime_readiness._last_error = saved
        from app.core.database import engine

        await engine.dispose()
