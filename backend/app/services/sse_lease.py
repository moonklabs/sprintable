"""#2121: SSE 연결 카운터(429/503) → Redis ZSET lease (TTL 자가회수).

process-local 카운터(events.py `_sse_connection_count`·agent_gateway `_agent_sse_connection_count`·
per-key `len(_agent_connections[...])`)를 Redis ZSET 으로 공유 → 멀티인스턴스 합산 정확·429/503 오발 제거.

자료구조: per-scope ZSET, member=connection_id(lease id), score=만료ts.
  scope 예: "events_global"(브라우저 /events/stream 전역)·"agent_global"(/agent/stream 전역)·"perkey:{agent_id}".
⭐**TTL 주경로**: 좀비 연결(refresh 끊김)은 score 지나면 count 에서 자동 evict → #2128(disconnect 미감지·
  finally 미실행) 을 부분 완화(현재는 리퍼가 전혀 없어 3600s 까지 점유). 명시 release(finally)는 최적화.
⭐**원자성**: check(evict+ZCARD)+조건부 ZADD 를 **Lua 1스크립트**로 실행(TOCTOU 방지 — 동시 acquire 가
  둘 다 count<limit 을 보고 초과 획득하는 것 차단).

fail-open tri-state(presence_online 준용): acquire → True(획득)/False(한계초과=429/503)/**None(Redis 불가)**.
  None 이면 호출부가 **in-process 카운트로 폴백**(현 동작·연결 거부 안 함). 살아있는 Redis 의 False 만 거부.
독립 flag `sse_lease_redis_enabled`(#2120 교훈 — 롤백이 검증완료 presence/§2 를 끄면 안 됨).
"""
from __future__ import annotations

import logging
import os
import time

from app.core.config import settings
from app.services import redis_shared

logger = logging.getLogger(__name__)

_DOMAIN = "ratelimit"
# 연결 살아있음 refresh 주기(SSE 30s 틱)의 3배 = 90s(2회 누락 허용·presence 와 동일 근거).
_TTL_SEC = int(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30")) * 3
_KEY_TTL_SEC = _TTL_SEC * 4  # ZSET 키 자체 leak backstop

# KEYS[1]=zset · ARGV[1]=now(만료 evict 기준) · ARGV[2]=now+TTL(신규 score) · ARGV[3]=limit ·
# ARGV[4]=conn_id · ARGV[5]=key TTL. 만료(score<=now) evict → ZCARD → count<limit 이면 ZADD 후 1, 아니면 0.
_ACQUIRE_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
"""


def _enabled() -> bool:
    return bool(getattr(settings, "sse_lease_redis_enabled", False)) and bool(settings.redis_url)


def _key(scope: str) -> str:
    return redis_shared.key(_DOMAIN, "sse_lease", scope)


async def acquire(scope: str, limit: int, conn_id: str) -> "bool | None":
    """lease 슬롯 원자 획득 시도.

    True  = 획득(연결 허용) · False = 한계 초과(429/503 거부) · **None = Redis 불가(off/다운/에러)**.
    None 이면 호출부는 in-process 카운트로 폴백(fail-open·연결 거부 안 함).
    """
    if not _enabled():
        return None
    client = redis_shared.get_client()
    if client is None:
        return None
    now = time.time()
    try:
        res = await client.eval(
            _ACQUIRE_LUA, 1, _key(scope), now, now + _TTL_SEC, limit, conn_id, _KEY_TTL_SEC
        )
        return bool(res)
    except Exception:
        logger.warning("sse_lease.acquire failed → caller in-process fallback", exc_info=True)
        return None


async def refresh(scope: str, conn_id: str) -> None:
    """연결 살아있음 신호 — lease score 재갱신(SSE 틱에 편승). off/Redis 다운 → no-op."""
    if not _enabled():
        return

    async def _op(client) -> None:
        pipe = client.pipeline()
        pipe.zadd(_key(scope), {conn_id: time.time() + _TTL_SEC})
        pipe.expire(_key(scope), _KEY_TTL_SEC)
        await pipe.execute()

    await redis_shared.with_fallback(_op, lambda: None)


async def release(scope: str, conn_id: str) -> None:
    """명시 해제(generate() finally·**최적화만**). off/Redis 다운 → no-op(TTL 이 자가회수)."""
    if not _enabled():
        return

    async def _op(client) -> None:
        await client.zrem(_key(scope), conn_id)

    await redis_shared.with_fallback(_op, lambda: None)


async def count(scope: str) -> "int | None":
    """현 lease 카운트(만료 evict 후 ZCARD) — 관측/AC5 판별용. None = Redis 불가."""
    if not _enabled():
        return None
    client = redis_shared.get_client()
    if client is None:
        return None
    try:
        await client.zremrangebyscore(_key(scope), "-inf", time.time())
        return int(await client.zcard(_key(scope)))
    except Exception:
        logger.warning("sse_lease.count failed", exc_info=True)
        return None
