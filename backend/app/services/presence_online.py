"""#2120 AC2: online liveness를 Redis 키로 — 30s SSE-틱 hot-path DB write 제거.

per-member online 키(값=마지막 틱 ISO ts·EX 90s). 세 소비자:
- 라우터(team_members/team_presence): effective_last_seen 주입(Redis ts ?? DB last_seen_at) — computed_field 무변경.
- reachability(agent_verify._has_fresh_session): 도달성 판정(키 존재)·Redis 불가 시 세션-row 존재로 폴백(fail-open).
- 좀비 GC: Redis 부재 기반으로 게이트(live long-connection row 오삭제 방지).

flag `presence_online_redis_enabled`(§2 presence_redis_enabled 와 **독립** kill switch — AC2 롤백이 검증완료
§2 를 끄지 않게). off = 현 DB-틱 경로 그대로(무회귀). on 이라도 connect/disconnect DB write 는 유지(내구+폴백).
"""
from __future__ import annotations

import datetime
import logging
import os

from app.core.config import settings
from app.services import redis_shared

logger = logging.getLogger(__name__)

_DOMAIN = "presence"
# SSE 30s 틱 × 3 = 90s(2회 누락 허용·기존 _SESSION_FRESH_TTL 과 동일 근거).
_TTL_SEC = int(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30")) * 3


def _enabled() -> bool:
    return bool(getattr(settings, "presence_online_redis_enabled", False)) and bool(settings.redis_url)


def _key(member_id: str) -> str:
    return redis_shared.key(_DOMAIN, "online", str(member_id))


async def mark_online(member_id: str) -> None:
    """연결 라이브니스 갱신 — online 키 SET(now ISO, EX 90). off/Redis 다운 → no-op(연결/해제 DB가 폴백)."""
    if not _enabled():
        return
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()

    async def _op(client) -> None:
        await client.set(_key(member_id), ts, ex=_TTL_SEC)

    await redis_shared.with_fallback(_op, lambda: None)


async def clear_online(member_id: str) -> None:
    """마지막 disconnect — online 키 DEL(즉시 offline·90s 잔존 방지). off/다운 → no-op."""
    if not _enabled():
        return

    async def _op(client) -> None:
        await client.delete(_key(member_id))

    await redis_shared.with_fallback(_op, lambda: None)


# story #4834: «shorten the key unless a connection renewed it after `bound`» in ONE step on the server — a GET and a PEXPIRE sent one after the other leave a gap in which
# a reconnect's tick can renew the key and the PEXPIRE then still shortens it. The key's value is the time of the last tick as an ISO string with a UTC offset, which sorts
# like the time itself (byte order; a whole second without microseconds sorts before the same second with them, which is the right way round).
_EXPIRE_UNLESS_RENEWED = """
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
if v > ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
"""


async def expire_online(member_id: str, seconds: float, *, unless_renewed_after: "datetime.datetime | None" = None) -> None:
    """story #4834 — a stream that ended by its lifespan: shorten the online key to `seconds` instead of deleting it (the client reconnects at once and its first tick
    renews the key; one that does not reads as gone when the key runs out). Nothing to shorten (no key · off · Redis down) → no-op.

    `unless_renewed_after`: the key holds the time of the last tick; one later than this was written by a connection that came back while the caller's cleanup was
    still running — that key is live and is left alone (checked and shortened atomically). A failure here (Redis down at that moment) leaves the key to its own ≤ 90 s
    life — the same as a server that died (no cleanup at all) or a failed `clear_online`: the key always ends 90 s after the last tick."""
    if not _enabled():
        return
    ms = max(int(seconds * 1000), 1)

    async def _op(client) -> None:
        if unless_renewed_after is None:
            await client.pexpire(_key(member_id), ms)
        else:
            await client.eval(_EXPIRE_UNLESS_RENEWED, 1, _key(member_id), unless_renewed_after.isoformat(), ms)

    await redis_shared.with_fallback(_op, lambda: None)


async def get_online_map(member_ids) -> dict[str, str]:
    """member_ids 중 online 키가 살아있는 것 → {member_id: ts}. 라우터 last_seen_at 주입용.

    off/Redis 다운/키 부재 → 해당 member 미포함(라우터가 DB last_seen_at 로 폴백). 배치 MGET(1 라운드트립).
    """
    ids = [str(m) for m in member_ids]
    if not _enabled() or not ids:
        return {}

    async def _op(client) -> dict[str, str]:
        vals = await client.mget([_key(m) for m in ids])
        return {m: v for m, v in zip(ids, vals) if v}

    return await redis_shared.with_fallback(_op, lambda: {})


async def is_online(member_id: str) -> "bool | None":
    """reachability 판정 — online 키 존재 여부. True/False = Redis 판정.

    **None = Redis 불가(off/다운/에러)** → 호출부가 세션-row **존재 여부**(freshness 아님)로 폴백해야 함
    (fail-open: 도달성=메시지 배달 경로라 Redis 다운서도 연결중이면 배달 유지).
    """
    if not _enabled():
        return None
    client = redis_shared.get_client()
    if client is None:
        return None
    try:
        return bool(await client.exists(_key(member_id)))
    except Exception:
        logger.warning("presence_online.is_online failed → caller session-row fallback", exc_info=True)
        return None
