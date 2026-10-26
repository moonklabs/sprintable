"""story 4788 (INFRA-DIET ③ · PO 10-26, the root) — an event that the last few replays of the same kind of connection all sent is not sent again on every reconnect.

The agent stream replays everything after the agent's cursor on each connect. A client that never acks some of those events (the plugin 0.9.x drops what it does not act on before acking) was sent the whole tail
again on every reconnect, for ever — prod: 25.9 MB per stream. Declaring what a client acts on (test_4788_agent_stream_replay_realdb.py) fixes the clients that declare; this is the server's guard for the ones that do not.
These tests run the real `agent_stream()` over a real database and fakeredis (the per-(agent · key · declaration) counts live in Redis):
- the root: one tail, five reconnects — the first three send it (each to a connection that was still there afterwards), the fourth and fifth send nothing; the log line says where the connect started;
- no loss: an event newer than what was sent is sent; an event sent fewer times than the limit is sent again; a connection that was not there afterwards counts for nothing; an event younger than SETTLE_SEC is never part of
  the floor (a late commit with a lower seq must still arrive); a replay that sent nothing — a client's stale `Last-Event-ID` above every event — records nothing;
- no crossing: another key, or a connection that declared other types, never skips what another kind of connection was sent; `AGENT_STREAM_REPLAY_ATTEMPTS=0` turns it off;
- every test runs twice — on Redis (shared by every instance) and with NO Redis (one process on one VM: the counts live in the process's memory, bounded) — the replay must stop in both; a process restart forgets the counts in the second;
- the agent's cursor is never written."""
from __future__ import annotations

import json
import logging
import os
import uuid

import pytest

from tests.test_4788_agent_stream_replay_realdb import ACTS, FYI, PLUGIN, _cleanup, _event, _Reader, _types, _world
from tests.agent_stream_auth import agent_stream_claims, seed_agent_stream_key

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True, params=["redis", "no_redis"])
def _store_and_limits(request, monkeypatch):
    """the shared store: fakeredis, or none at all (one process — the counts live in this process); a connection counts as «still there afterwards» at once (the real wait is 60 s — pinned in test_08)"""
    from unittest.mock import patch

    from app.services import agent_stream_replay_floor as f

    monkeypatch.setattr(f, "MIN_ALIVE_SEC", 0.0)
    monkeypatch.setattr(f, "SETTLE_SEC", 0.0)  # (the real wait is 120 s — test_10 pins that a fresh event is not counted)
    monkeypatch.setattr(f, "ATTEMPTS", 3)
    f._local.clear()
    if request.param == "redis":
        aioredis = pytest.importorskip("fakeredis.aioredis")
        client = aioredis.FakeRedis(server=aioredis.FakeServer(), decode_responses=True)
        with patch("app.services.redis_shared.get_client", return_value=client):
            yield request.param
    else:
        with patch("app.services.redis_shared.get_client", return_value=None):
            yield request.param
    f._local.clear()


async def _open_as(ag, Session, ids, headers, key_id):
    from app.dependencies.auth import AuthContext
    from tests.test_4788_agent_stream_replay_realdb import _Request

    auth = AuthContext(user_id=str(ids[2]), email=None, claims=agent_stream_claims(key_id, ids[0]))
    resp = await ag.agent_stream(_Request(headers), auth=auth)
    assert resp.status_code == 200
    return resp.body_iterator


async def _connect_as(ag, Session, ids, headers, key_id) -> list[str]:
    reader = _Reader(await _open_as(ag, Session, ids, headers, key_id))
    try:
        return await reader.frames()
    finally:
        await reader.close()


async def _key(Session, ids) -> uuid.UUID:
    async with Session() as s:
        return await seed_agent_stream_key(s, ids[2])


def _seqs(frames):
    return [json.loads(next(line for line in f.splitlines() if line.startswith("data: "))[6:])["recipient_seq"] for f in frames]


async def test_01_the_root_one_tail_five_reconnects_the_first_three_send_it_and_then_nothing(monkeypatch, caplog):
    ag, engine, Session, ids = await _world(monkeypatch, tail=120)
    try:
        key = await _key(Session, ids)
        sizes = []
        with caplog.at_level(logging.INFO, logger="app.routers.agent_gateway"):
            for _ in range(5):
                frames = await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)
                sizes.append((len(frames), sum(len(f.encode()) for f in frames)))
        print(f"\n[4788 root] a tail of 120 events · 5 reconnects of a client that does not declare → (frames, bytes) per connect {sizes}")
        assert [n for n, _ in sizes] == [120, 120, 120, 0, 0], sizes
        lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("agent_stream backfill")]
        assert [" skipped_to=0 " in ln for ln in lines] == [True, True, True, False, False], lines
        assert all("rows=0" in ln and " skipped_to=" in ln for ln in lines[3:]), lines[3:]
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_02_no_loss_a_newer_event_is_sent_and_an_event_sent_fewer_times_than_the_limit_is_sent_again(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=10)
    try:
        key = await _key(Session, ids)
        H = {"user-agent": "Bun/1.4.2"}
        assert len(await _connect_as(ag, Session, ids, H, key)) == 10
        assert len(await _connect_as(ag, Session, ids, H, key)) == 10  # sent twice: not yet left out
        for _ in range(5):
            await _event(Session, ids, FYI)
        third = await _connect_as(ag, Session, ids, H, key)
        assert len(third) == 15, "the first ten for the third time, the five new ones for the first"
        fourth = await _connect_as(ag, Session, ids, H, key)
        assert len(fourth) == 5, "the first ten have been sent in each of the last three: left out; the five new ones were sent once: sent again"
        newest = await _event(Session, ids, ACTS)
        fifth = await _connect_as(ag, Session, ids, H, key)
        assert newest in _seqs(fifth) and len(fifth) == 6, "and an event newer than anything sent is always sent (the five: second time; the new one: first)"
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_03_a_connection_that_was_not_there_afterwards_counts_for_nothing(monkeypatch):
    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=20)
    try:
        monkeypatch.setattr(f, "MIN_ALIVE_SEC", 3600.0)  # none of these connections lives that long
        key = await _key(Session, ids)
        for _ in range(5):
            assert len(await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)) == 20
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_04_another_key_or_another_declaration_never_skips_what_another_kind_of_connection_was_sent(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=30)
    try:
        key, other_key = await _key(Session, ids), await _key(Session, ids)
        H = {"user-agent": "Bun/1.4.2"}
        for _ in range(3):
            assert len(await _connect_as(ag, Session, ids, H, key)) == 30
        assert await _connect_as(ag, Session, ids, H, key) == [], "this kind of connection: left out"
        assert len(await _connect_as(ag, Session, ids, H, other_key)) == 30, "another key has its own count"
        declared = {"x-sprintable-accept-events": FYI}
        assert len(await _connect_as(ag, Session, ids, declared, key)) == 30, "a connection that declared FYI types is another kind: it was never sent them"
        assert _types(await _connect_as(ag, Session, ids, {**PLUGIN}, key)) == [], "the plugin's declared set has none of them"
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_05_the_switch_turns_it_off_and_a_restart_of_a_no_redis_process_forgets_the_counts(monkeypatch, _store_and_limits):
    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=12)
    try:
        key = await _key(Session, ids)
        H = {"user-agent": "Bun/1.4.2"}
        for _ in range(3):
            assert len(await _connect_as(ag, Session, ids, H, key)) == 12
        assert await _connect_as(ag, Session, ids, H, key) == []
        if _store_and_limits == "no_redis":
            f._local.clear()  # the process restarted: its memory is gone
            assert len(await _connect_as(ag, Session, ids, H, key)) == 12, "forgotten: the tail is sent again — and then it stops again"
            for _ in range(2):
                assert len(await _connect_as(ag, Session, ids, H, key)) == 12
            assert await _connect_as(ag, Session, ids, H, key) == []
        monkeypatch.setattr(f, "ATTEMPTS", 0)  # AGENT_STREAM_REPLAY_ATTEMPTS=0
        for _ in range(5):
            assert len(await _connect_as(ag, Session, ids, H, key)) == 12
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_06_the_agents_cursor_is_never_written_by_it(monkeypatch):
    from sqlalchemy import select

    from app.models.agent_gateway import AgentEventCursor

    ag, engine, Session, ids = await _world(monkeypatch, tail=8)
    try:
        key = await _key(Session, ids)
        async with Session() as s:
            before = (await s.execute(select(AgentEventCursor.acked_seq).where(AgentEventCursor.agent_id == ids[2]))).scalar_one()
        for _ in range(5):
            await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)
        async with Session() as s:
            after = (await s.execute(select(AgentEventCursor.acked_seq).where(AgentEventCursor.agent_id == ids[2]))).scalar_one()
        assert after == before
        # another connection of the same agent (the desktop app: its own receiver, everything) still gets the whole tail
        assert len(await _connect_as(ag, Session, ids, {"user-agent": "node", "x-sprintable-receiver-id": "rcv_" + "A" * 22}, await _key(Session, ids))) == 8
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_07_the_connect_log_line_says_where_it_started(monkeypatch, caplog):
    ag, engine, Session, ids = await _world(monkeypatch, tail=6)
    try:
        key = await _key(Session, ids)
        with caplog.at_level(logging.INFO, logger="app.routers.agent_gateway"):
            for _ in range(4):
                await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)
        last = [r.getMessage() for r in caplog.records if r.getMessage().startswith("agent_stream backfill")][-1]
        assert " skipped_to=" in last and " skipped_to=0 " not in last and "rows=0" in last, last
    finally:
        await _cleanup(ag, engine, ids[2])


def test_08_the_pieces(monkeypatch):
    import asyncio

    from app.services import agent_stream_replay_floor as f

    import inspect  # (the fixture patched ATTEMPTS and MIN_ALIVE_SEC; the defaults are read from the source)

    src = inspect.getsource(f)
    assert 'os.getenv("AGENT_STREAM_REPLAY_ATTEMPTS", "3")' in src and 'os.getenv("AGENT_STREAM_REPLAY_MIN_ALIVE_SEC", "60")' in src
    assert f.variant(None) == "all" and f.variant(frozenset({"a", "b"})) == f.variant(frozenset({"b", "a"})) != f.variant(frozenset({"a"}))
    agent, key = uuid.uuid4(), uuid.uuid4()

    async def run():
        assert await f.floor(agent, key, None) == 0
        await f.record(agent, key, None, 0)  # nothing to count
        await f.record(agent, key, None, 50)
        await f.record(agent, key, None, 60)
        assert await f.floor(agent, key, None) == 0, "two records are fewer than the limit"
        await f.record(agent, key, None, 70)
        assert await f.floor(agent, key, None) == 50, "the lowest of the last three"
        await f.record(agent, key, None, 90)
        assert await f.floor(agent, key, None) == 60, "only the last three count"
        assert await f.floor(agent, None, None) == 0 and await f.floor(agent, uuid.uuid4(), None) == 0

    asyncio.run(run())


def test_09_without_redis_the_process_memory_is_bounded_and_expires(monkeypatch, _store_and_limits):
    import asyncio
    from unittest.mock import patch

    from app.services import agent_stream_replay_floor as f

    agent = uuid.uuid4()

    async def run():
        with patch("app.services.redis_shared.get_client", return_value=None):
            monkeypatch.setattr(f, "MAX_LOCAL_KEYS", 3)
            keys = [uuid.uuid4() for _ in range(5)]
            for k in keys:
                for v in (10, 20, 30):
                    await f.record(agent, k, None, v)
            assert len(f._local) == 3, "bounded: the least recently used go first"
            assert await f.floor(agent, keys[-1], None) == 10 and await f.floor(agent, keys[0], None) == 0
            # expiry
            now = [1000.0]
            monkeypatch.setattr(f.time, "monotonic", lambda: now[0])
            f._local.clear()
            k = uuid.uuid4()
            for v in (5, 6, 7):
                await f.record(agent, k, None, v)
            assert await f.floor(agent, k, None) == 5
            now[0] += f.TTL_SEC + 1
            assert await f.floor(agent, k, None) == 0 and not f._local, "expired: forgotten"

    asyncio.run(run())


async def test_10_an_event_younger_than_the_settle_time_is_never_part_of_the_floor(monkeypatch):
    """a late commit (a lower seq that commits after a higher one was sent) must still arrive: the floor only ever covers events older than SETTLE_SEC"""
    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=15)
    try:
        monkeypatch.setattr(f, "SETTLE_SEC", 3600.0)  # every event of this test is far younger than that
        key = await _key(Session, ids)
        for _ in range(6):
            assert len(await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)) == 15
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_11_a_replay_that_sent_nothing_records_nothing_a_stale_last_event_id_cannot_become_the_floor(monkeypatch):
    ag, engine, Session, ids = await _world(monkeypatch, tail=15)
    try:
        key = await _key(Session, ids)
        for _ in range(4):
            stale = await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2", "last-event-id": "999999999"}, key)
            assert stale == [], "the client says it has everything up to there"
        assert len(await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)) == 15, "three empty replays are not three sends of anything"
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_12_a_cut_off_cleanup_still_runs_when_the_record_fails(monkeypatch):
    """the count is a hint for the next connect: when writing it raises, the connection's cleanup (cap counter · lease · connection list) has already run and nothing escapes"""
    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=5)
    try:
        async def _boom(*a, **k):
            raise RuntimeError("redis down")

        monkeypatch.setattr(f, "record", _boom)
        before = ag._agent_sse_connection_count
        key = await _key(Session, ids)
        assert len(await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)) == 5
        assert ag._agent_sse_connection_count == before, "the connection was released"
        assert str(ids[2]) not in ag._agent_connections
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_13_the_settled_run_stops_at_the_first_fresh_event(monkeypatch):
    """old · old · FRESH · old · old: the floor may cover the first two only — the fresh one could be a late commit with a lower seq than the old ones after it"""
    from sqlalchemy import text

    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=10)
    try:
        monkeypatch.setattr(f, "SETTLE_SEC", 60.0)
        async with Session() as s:
            seqs = [r[0] for r in (await s.execute(text("SELECT recipient_seq FROM events WHERE recipient_id = :a ORDER BY recipient_seq"), {"a": ids[2]})).all()]
            tail = seqs[5:]
            assert len(tail) == 10
            await s.execute(text("UPDATE events SET created_at = now() - interval '1 hour' WHERE recipient_id = :a AND recipient_seq <> :fresh"), {"a": ids[2], "fresh": tail[4]})
            await s.commit()
        key = await _key(Session, ids)
        H = {"user-agent": "Bun/1.4.2"}
        for _ in range(3):
            assert len(await _connect_as(ag, Session, ids, H, key)) == 10
        fourth = await _connect_as(ag, Session, ids, H, key)
        assert _seqs(fourth) == tail[4:], "the first four are covered; the fresh one and everything after it is sent again, the old ones after it too"
    finally:
        await _cleanup(ag, engine, ids[2])


async def test_14_the_record_is_written_after_the_connection_is_released(monkeypatch):
    """the count is the last thing the end of a connection does: when it is written, the cap counter, the lease and the connection list are already clean (a cut-off write cannot leave them behind)"""
    from app.services import agent_stream_replay_floor as f

    ag, engine, Session, ids = await _world(monkeypatch, tail=4)
    try:
        seen: list[tuple[int, bool]] = []
        real = f.record

        async def _spy(*a, **k):
            seen.append((ag._agent_sse_connection_count, str(ids[2]) in ag._agent_connections))
            return await real(*a, **k)

        monkeypatch.setattr(f, "record", _spy)
        before = ag._agent_sse_connection_count
        key = await _key(Session, ids)
        assert len(await _connect_as(ag, Session, ids, {"user-agent": "Bun/1.4.2"}, key)) == 4
        assert seen == [(before, False)], seen
    finally:
        await _cleanup(ag, engine, ids[2])
