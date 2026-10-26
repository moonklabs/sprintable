"""story 4788 (INFRA-DIET ③ · PO 10-26 root) — an event the stream has sent a few times to the same kind of connection is not replayed on every reconnect.

`GET /api/v2/agent/stream` replays every event after the agent's cursor on each connect. A client that never acks some of them (the Claude Code plugin 0.9.x drops events outside its allow-list before acking; the cursor
stops at the last event it acted on) got the whole tail again on every reconnect, for ever: prod, one Bun stream 25.9 MB per connect, ≈44 GB a day. A client that declares what it acts on (`X-Sprintable-Accept-Events`) is
already sent only that. This is the server-side guard for the clients that do not.

Per (agent, API key, kind of connection) the server keeps what its last `ATTEMPTS` replays covered: the highest seq each of them sent — counting only the unbroken run of events older than `SETTLE_SEC`, so one that
committed late with a lower seq is never under the floor — while the connection stayed open `MIN_ALIVE_SEC` after the replay (a client that read the replay and was still there). A replay that sent nothing records nothing.
(Seq order is commit order per recipient — `event_seq.assign_recipient_seq` takes the recipient's counter row lock, so seq N+1 cannot be issued before N commits and no event commits late with a lower seq. The settle
time is a second line behind that invariant, not the first: it costs a fresh event at most a few extra sends, and keeps the floor correct if the invariant is ever loosened.) The next connect starts after the LOWEST of those — an event that was sent in each of the last `ATTEMPTS` such connections is not replayed again; any newer event is. Nothing the
client acked is touched (the cursor is the client's), and nothing is lost for good that a client could still need:
- an event is sent `ATTEMPTS` times (default 3) before it is left out, each time to a connection that was alive for a while afterwards — a client that crashed before it handled an event, or a connection cut at once, gets it again;
- the count is per kind of connection (declared types / none) and per key: a connection that declared other types, or another key, never skips what another kind of connection was sent;
- the counts live in Redis when there is one (every instance shares them); without Redis — one process on one VM — they live in this process's memory (bounded), so the replay stops there too. A restart of the
  process forgets them: the next `ATTEMPTS` connects of each client send the tail again, then it stops again. `AGENT_STREAM_REPLAY_ATTEMPTS=0` turns the whole thing off.
The agent's durable cursor (`acked_seq`) is never written here.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from collections import OrderedDict

from app.services import redis_shared

logger = logging.getLogger(__name__)

ATTEMPTS: int = int(os.getenv("AGENT_STREAM_REPLAY_ATTEMPTS", "3"))
MIN_ALIVE_SEC: float = float(os.getenv("AGENT_STREAM_REPLAY_MIN_ALIVE_SEC", "60"))
# only events older than this when a replay sent them are counted: an event whose transaction is still open can commit with a LOWER seq than one already sent (a late commit), and the live rescans catch it only
# above the floor. A transaction that stays open longer than this is the one case that can still be missed — documented, not silent.
SETTLE_SEC: float = float(os.getenv("AGENT_STREAM_REPLAY_SETTLE_SEC", "120"))
TTL_SEC: int = 7 * 86400
IO_TIMEOUT_SEC: float = 2.0  # a store that does not answer (a black-holed Redis) must not hold a connect (the read) or pile up tasks (the write)
MAX_PENDING_WRITES: int = 2000
MAX_LOCAL_KEYS: int = 20000  # (agent · key · kind) entries held in this process when there is no Redis; the least recently used go first

# no Redis: key -> (expires_at, newest-first sent_max values). Single-process state — the Redis path is the shared one.
_local: "OrderedDict[str, tuple[float, list[int]]]" = OrderedDict()


def _local_read(key: str) -> list[int]:
    hit = _local.get(key)
    if hit is None:
        return []
    if hit[0] < time.monotonic():
        _local.pop(key, None)
        return []
    _local.move_to_end(key)
    return hit[1]


def _local_push(key: str, value: int) -> None:
    vals = [value, *_local_read(key)][:ATTEMPTS]
    _local[key] = (time.monotonic() + TTL_SEC, vals)
    _local.move_to_end(key)
    while len(_local) > MAX_LOCAL_KEYS:
        _local.popitem(last=False)


def variant(accept_types: "frozenset[str] | None") -> str:
    """the kind of connection: everything (`all`) or a declared set (a short digest of it)"""
    if accept_types is None:
        return "all"
    return "d" + hashlib.sha1("\n".join(sorted(accept_types)).encode()).hexdigest()[:12]


def _key(agent_id: uuid.UUID | str, key_id: object, accept_types: "frozenset[str] | None") -> str:
    return redis_shared.key("agent_stream_replay", str(agent_id), str(key_id), variant(accept_types))


async def floor(agent_id: uuid.UUID | str, key_id: object, accept_types: "frozenset[str] | None") -> int:
    """the seq a connect may start after because the last ATTEMPTS replays of this kind of connection all sent up to it (0 = no such knowledge)"""
    if ATTEMPTS <= 0 or not key_id:
        return 0
    key = _key(agent_id, key_id, accept_types)

    def _pick(vals: list[int]) -> int:
        return min(vals[:ATTEMPTS]) if len(vals) >= ATTEMPTS else 0

    async def _op(client) -> int:
        raw = await client.lrange(key, 0, ATTEMPTS - 1)
        return _pick([int(v) for v in raw if str(v).lstrip("-").isdigit()])

    try:
        return await asyncio.wait_for(redis_shared.with_fallback(_op, lambda: _pick(_local_read(key))), IO_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        logger.warning("agent_stream replay floor read timed out agent=%s — nothing skipped", agent_id)
        return 0


async def record(agent_id: uuid.UUID | str, key_id: object, accept_types: "frozenset[str] | None", sent_max: int) -> None:
    """a connection of this kind replayed up to `sent_max` and was still there afterwards"""
    if ATTEMPTS <= 0 or not key_id or sent_max <= 0:
        return
    key = _key(agent_id, key_id, accept_types)

    async def _op(client) -> None:
        await client.lpush(key, str(int(sent_max)))
        await client.ltrim(key, 0, ATTEMPTS - 1)
        await client.expire(key, TTL_SEC)

    await redis_shared.with_fallback(_op, lambda: _local_push(key, int(sent_max)))


_pending: "set[asyncio.Task]" = set()  # the writes that are still waiting (counted for MAX_PENDING_WRITES)


def record_soon(agent_id: uuid.UUID | str, key_id: object, accept_types: "frozenset[str] | None", sent_max: int) -> None:
    """`record`, started as its own task and not awaited. The end of a stream is run by Starlette inside an anyio cancel scope when the client goes away, and that cancellation is level-triggered: every
    real `await` left in the stream's `finally` raises CancelledError again — a `record` awaited there never ran (Kadir's lens on 5265, measured on a real uvicorn: not once). A task of its own is not in
    that scope, so it finishes; it needs no clean-up order either, and a slow store cannot delay the clean-up of the connection. A failure is a warning: the count is a hint for the next connect."""
    if ATTEMPTS <= 0 or not key_id or sent_max <= 0:
        return

    if len(_pending) >= MAX_PENDING_WRITES:  # a store that stopped answering: counts are dropped rather than piled up
        logger.warning("agent_stream replay floor: %d writes still pending — this count is dropped agent=%s", len(_pending), agent_id)
        return

    async def _run() -> None:
        try:
            await asyncio.wait_for(record(agent_id, key_id, accept_types, sent_max), IO_TIMEOUT_SEC * 2.5)
        except Exception:  # noqa: BLE001 — a count for the next connect, never a condition of this one (a timeout too)
            logger.warning("agent_stream replay floor record failed agent=%s", agent_id, exc_info=True)

    from app.services.pg_pubsub import fire_and_forget  # the repo's one way to start a task nobody awaits (strong reference · drained at shutdown · test_no_unreferenced_fire_and_forget)

    task = fire_and_forget(_run())
    if task is None:  # no running loop (cannot happen inside the stream; a call from elsewhere just does not record)
        return
    _pending.add(task)  # (only to count how many writes wait — the reference that keeps the task alive is fire_and_forget's)
    task.add_done_callback(_pending.discard)
