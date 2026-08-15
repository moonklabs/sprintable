"""#2121: SSE 연결 카운터(429/503) → Redis ZSET lease (TTL 자가회수).

process-local 카운터(events.py `_sse_connection_count`·agent_gateway `_agent_sse_connection_count`·
per-key `len(_agent_connections[...])`)를 Redis ZSET 으로 공유 → 멀티인스턴스 합산 정확·429/503 오발 제거.

자료구조: per-scope ZSET, member=connection_id(lease id), score=만료ts.
  scope 예: "events_global"(브라우저 /events/stream 전역)·"agent_global"(/agent/stream 전역)·"perkey:{agent_id}".
⭐**TTL 주경로**: 좀비 연결(refresh 끊김)은 score 지나면 count 에서 자동 evict → #2128(disconnect 미감지·
  finally 미실행) 을 부분 완화(현재는 리퍼가 전혀 없어 3600s 까지 점유). 명시 release(finally)는 최적화.
⚠️story #2602(2026-08-13, dev 라이브 재현): 위 "TTL 주경로"는 **refresh 가 실제로 멈춘 경우에만** 성립한다
  — refresh(`agent_gateway.py` 30초 틱)는 `request.is_disconnected()` 로 게이트되는 같은 루프 안에서
  돌고, 그 판정 자체가 이 코드베이스에서 이미 여러 번(#2183·까심 AC6) 불신뢰로 확認됐다. **클라가 죽었는데
  서버가 그걸 못 알아챈 orphan**은 refresh 도 안 멈춘다 — 매 30초 틱마다 자기 lease 를 스스로 갱신해
  `_TTL_SEC`(90초) 만료가 영영 안 온다. 이 실패군에서 실제 상한선은 이 TTL 이 아니라
  `agent_gateway._AGENT_SSE_LIFESPAN_SEC`(+jitter, 기본 ~300~330초) 능동 종료뿐이다(disconnect 감지와
  무관하게 발동 — #2128 참조). Retry-After 계산(`earliest_expiry`)이 "방금 갱신된 live" 구간을 만나면
  flat default 로 폴백하는 것(#2582 PO 리뷰, 2026-08-12)은 **의도된 그대로**다 — 그 순간엔 live 세션과
  이 orphan 을 스코어만으로 구분할 수 없어서다(구분 시도가 오히려 다른 세션의 빠른 정상종료를 못 보게
  만든다). 그러니 이 TTL 을 "90초 안에 자연 회수"로 신뢰하지 말 것 — 실제 정직한 상한은 lifespan cap.
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
_HEARTBEAT_SEC = int(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))
# 연결 살아있음 refresh 주기(SSE 30s 틱)의 3배 = 90s(2회 누락 허용·presence 와 동일 근거).
_TTL_SEC = _HEARTBEAT_SEC * 3
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


async def earliest_expiry(scope: str) -> "float | None":
    """story #2582: 그 scope에서 가장 먼저 만료될 lease의 score(epoch 초) — acquire()가 False를
    반환했을 때 호출부가 정확한 Retry-After를 계산하는 용도(현재 agent_gateway의 flat
    `_AGENT_STREAM_RETRY_AFTER`(기본 5s)는 실제 자가회수까지 걸릴 수 있는 최대 시간(`_TTL_SEC`,
    기본 90s)과 무관해 클라이언트가 실제 해소보다 훨씬 일찍·반복적으로 재시도하게 만든다 —
    비정상 종료로 slot이 orphan인 채 최대 TTL만큼 남아있는 게 바로 이 상황).

    ⭐PO 리뷰(2026-08-12) — orphan(heartbeat 끊김 → score 고정 드레인)과 live-full(heartbeat
    마다 score가 `now+TTL`로 계속 앞으로 밀리는, 한도를 채운 «살아있는» 세션들)을 score만으로
    뭉개면 안 된다: live 세션의 잔여시간은 항상 `[TTL-heartbeat, TTL]` 구간(막 갱신됨)에
    있고, 여기서 계산한 Retry-After로 돌아와도 그 세션이 계속 갱신 중이면 슬롯은 안 비어
    또 429다(«새 값도 이행 안 되는 약속») — 게다가 그 사이 다른 세션이 정상 종료로 슬롯을
    즉시 비워도 클라는 최대 그 값만큼(예: ~85s) 늦게 붙는다(구 flat 5s 폴링보다 오히려
    느려지는 회귀). 반면 orphan은 beat를 한 번이라도 놓치면 잔여시간이 그 구간 아래로
    드레인되므로, `remaining <= TTL-heartbeat`(beat 최소 1회 누락 확定)일 때만 이 값을
    신뢰한다 — 그 위(막 갱신된 live)면 예측이 성립 안 하니 None(호출부 flat 폴백)을 준다.

    None = Redis 불가·그 scope에 살아있는(미만료) lease가 하나도 없음·또는 가장 이른 lease가
    아직 «막 갱신된 live-full」 구간에 있어 만료 기반 예측이 성립하지 않음. 세 경우 다
    호출부는 flat default(폴링 간격으로서는 정직)로 폴백한다."""
    if not _enabled():
        return None
    client = redis_shared.get_client()
    if client is None:
        return None
    try:
        now = time.time()
        await client.zremrangebyscore(_key(scope), "-inf", now)
        res = await client.zrange(_key(scope), 0, 0, withscores=True)
        if not res:
            return None
        expiry = float(res[0][1])
        remaining = expiry - now
        if remaining > (_TTL_SEC - _HEARTBEAT_SEC):
            return None  # 막 갱신된 live-full — 만료 기반 예측 성립 안 함, flat 폴백
        return expiry
    except Exception:
        logger.warning("sse_lease.earliest_expiry failed", exc_info=True)
        return None
