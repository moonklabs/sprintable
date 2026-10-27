"""story 4791 (INFRA-DIET ⑥) — the SSE lease on Postgres rows, for when Redis is off.

`sse_lease.py` is the Redis ZSET lease. With Redis off the callers fell back to each instance's own memory, which cannot keep the desktop relay's
«one receiver per agent, take-over» contract once there are two backend instances: receiver A (instance 1) and receiver B (instance 2) did not know of each
other and both read the same command. This module is the same lease, same answers (True / False / None), kept in `sse_leases` / `sse_lease_taken`.

- **Scope: only `perkey:<agent id>`** (the agent stream's per-key place and the one-receiver rule). The global caps (`events_global`, `agent_global`) and the
  device stream's per-device count (`desktop:<setup>`) stay each instance's own count when Redis is off, as before — a deliberate limit of this story, not a gap
  (a browser stream would otherwise write a row per connection; the numbers are in the story).
- **Atomic acquire:** one transaction under `pg_advisory_xact_lock(scope)` — evict the lapsed, keep my own place if I hold it, else count and insert. Two
  instances asking for the last place at once are serialised (the Redis path does the same in one Lua script). A transaction-level lock is safe behind
  PgBouncer's transaction pooling.
- **Time is the database's** (`now()`): instances never compare their own clocks. `earliest_expiry` hands back an epoch computed from the remaining seconds.
- **Fail-open like Redis:** a database that cannot answer gives None (acquire / members / taken_by / earliest_expiry / count) or does nothing (refresh / release /
  mark / clear); the caller goes on with its in-process view. Nothing here refuses a connection because the database failed.
- Each call is its own short session (the stream's heartbeat is 30 s: one refresh and one mark read per stream per beat).
"""
from __future__ import annotations

import logging
import time

from sqlalchemy import text

from app.core.config import settings

logger = logging.getLogger(__name__)

_SCOPE_PREFIXES = ("perkey:",)
_SWEEP_EVERY_SEC = 600.0
_last_sweep = 0.0


def handles(scope: str) -> bool:
    """True when this scope's lease lives in Postgres (Redis off): the flag is on and the scope is one of the receiver scopes."""
    return bool(getattr(settings, "sse_lease_pg_enabled", False)) and scope.startswith(_SCOPE_PREFIXES)


def _session():
    # read at call time: a test (or the app) that swaps `app.core.database.async_session_factory` is honoured
    from app.core import database

    return database.async_session_factory()


async def acquire(scope: str, limit: int, member: str, ttl_sec: int) -> "bool | None":
    """True = I hold a place · False = the scope is full · None = the database could not answer (caller falls back in-process)."""
    global _last_sweep
    try:
        async with _session() as s:
            await s.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:scope, 0))"), {"scope": scope})
            await s.execute(text("DELETE FROM sse_leases WHERE scope = :scope AND expires_at <= now()"), {"scope": scope})
            mine = (await s.execute(
                text("UPDATE sse_leases SET expires_at = now() + make_interval(secs => :ttl) WHERE scope = :scope AND member = :member RETURNING 1"),
                {"scope": scope, "member": member, "ttl": float(ttl_sec)},
            )).first()
            granted = mine is not None
            if not granted:
                # the others only, and an upsert: the advisory lock serialises acquires, not `refresh` — the stream this member had before (a fail-open one that came back with
                # the database) may put its row back between the UPDATE above and here; counting that row as «another» would refuse the member's own reconnect (codex round 2)
                others = (await s.execute(
                    text("SELECT count(*) FROM sse_leases WHERE scope = :scope AND member <> :member"), {"scope": scope, "member": member}
                )).scalar_one()
                if others < limit:
                    await s.execute(
                        text(
                            "INSERT INTO sse_leases (scope, member, expires_at) VALUES (:scope, :member, now() + make_interval(secs => :ttl)) "
                            "ON CONFLICT (scope, member) DO UPDATE SET expires_at = EXCLUDED.expires_at"
                        ),
                        {"scope": scope, "member": member, "ttl": float(ttl_sec)},
                    )
                    granted = True
            now = time.monotonic()
            if now - _last_sweep >= _SWEEP_EVERY_SEC:  # leases of agents that never came back: an hour past their end is long gone
                _last_sweep = now
                await s.execute(text("DELETE FROM sse_leases WHERE expires_at < now() - interval '1 hour'"))
                await s.execute(text("DELETE FROM sse_lease_taken WHERE expires_at < now() - interval '1 hour'"))
            await s.commit()
            return granted
    except Exception:
        logger.warning("sse_lease_pg.acquire failed → caller in-process fallback", exc_info=True)
        return None


async def refresh(scope: str, member: str, ttl_sec: int) -> None:
    """the stream is alive — push its lapse time forward. An upsert, like the Redis ZADD (a lapsed place a live stream still holds comes back)."""
    try:
        async with _session() as s:
            await s.execute(
                text(
                    "INSERT INTO sse_leases (scope, member, expires_at) VALUES (:scope, :member, now() + make_interval(secs => :ttl)) "
                    "ON CONFLICT (scope, member) DO UPDATE SET expires_at = EXCLUDED.expires_at"
                ),
                {"scope": scope, "member": member, "ttl": float(ttl_sec)},
            )
            await s.commit()
    except Exception:
        logger.warning("sse_lease_pg.refresh failed", exc_info=True)


async def release(scope: str, member: str) -> None:
    try:
        async with _session() as s:
            await s.execute(text("DELETE FROM sse_leases WHERE scope = :scope AND member = :member"), {"scope": scope, "member": member})
            await s.commit()
    except Exception:
        logger.warning("sse_lease_pg.release failed", exc_info=True)


async def count(scope: str) -> "int | None":
    try:
        async with _session() as s:
            return int((await s.execute(text("SELECT count(*) FROM sse_leases WHERE scope = :scope AND expires_at > now()"), {"scope": scope})).scalar_one())
    except Exception:
        logger.warning("sse_lease_pg.count failed", exc_info=True)
        return None


async def members(scope: str) -> "list[str] | None":
    """the live members, the soonest to lapse first (the Redis ZRANGE order)."""
    try:
        async with _session() as s:
            rows = await s.execute(
                text("SELECT member FROM sse_leases WHERE scope = :scope AND expires_at > now() ORDER BY expires_at, member"), {"scope": scope}
            )
            return [r[0] for r in rows.all()]
    except Exception:
        logger.warning("sse_lease_pg.members failed", exc_info=True)
        return None


async def mark_taken(scope: str, member: str, ttl_sec: int) -> None:
    try:
        async with _session() as s:
            await s.execute(
                text(
                    "INSERT INTO sse_lease_taken (scope, member, expires_at) VALUES (:scope, :member, now() + make_interval(secs => :ttl)) "
                    "ON CONFLICT (scope) DO UPDATE SET member = EXCLUDED.member, expires_at = EXCLUDED.expires_at"
                ),
                {"scope": scope, "member": member, "ttl": float(ttl_sec)},
            )
            await s.commit()
    except Exception:
        logger.warning("sse_lease_pg.mark_taken failed", exc_info=True)


async def taken_by(scope: str) -> "str | None":
    try:
        async with _session() as s:
            row = (await s.execute(text("SELECT member FROM sse_lease_taken WHERE scope = :scope AND expires_at > now()"), {"scope": scope})).first()
            return None if row is None else row[0]
    except Exception:
        return None


async def clear_taken(scope: str, member: str) -> None:
    """delete the mark only while it is this member's — one statement, so a later taker's mark set in between is never removed."""
    try:
        async with _session() as s:
            await s.execute(text("DELETE FROM sse_lease_taken WHERE scope = :scope AND member = :member"), {"scope": scope, "member": member})
            await s.commit()
    except Exception:
        logger.warning("sse_lease_pg.clear_taken failed", exc_info=True)


async def earliest_expiry(scope: str, ttl_sec: int, heartbeat_sec: int) -> "float | None":
    """same rule as the Redis path: only a lease that has already missed a beat gives a trustworthy retry time; one just refreshed gives None."""
    try:
        async with _session() as s:
            remaining = (await s.execute(
                text("SELECT EXTRACT(EPOCH FROM (min(expires_at) - now())) FROM sse_leases WHERE scope = :scope AND expires_at > now()"), {"scope": scope}
            )).scalar_one()
        if remaining is None:
            return None
        remaining = float(remaining)
        if remaining > (ttl_sec - heartbeat_sec):
            return None
        return time.time() + remaining
    except Exception:
        logger.warning("sse_lease_pg.earliest_expiry failed", exc_info=True)
        return None
