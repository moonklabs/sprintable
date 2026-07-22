"""E-ARCH Wave2 공용 Redis 기반 — instance-local state → Redis 공유化의 공용층.

#2120 presence·#2121 429 lease·#2122 fanout·#2124 auth 가 공용으로 얹는 기반:
- **연결 재사용**: event_broker 의 async 싱글턴을 그대로 재사용(신규 연결 0). RedisRateLimiter 의
  별도 클라이언트도 #2121에서 이 accessor 로 통합 예정(연결 1개化).
- **env-scoped 키 네임스페이스**: `sprintable:{env}:{domain}:{parts…}` — env/도메인 격리.
- **폴백은 메커니즘만**: `with_fallback` 는 Redis 없음/에러 시 도메인이 준 fallback 을 호출할 뿐,
  정책(fail-open vs fail-closed)은 **특화층이 인자로 결정**한다(하드코딩 금지):
    presence = fail-open(in-memory degrade) · 429 = fail-open(허용) · fanout = local-only · auth = 신중.
- KV(SET/GET/ZADD/SETEX…)와 pub/sub(publish/psubscribe) 둘 다 같은 async 클라이언트로 커버.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, TypeVar

from app.core.config import settings

logger = logging.getLogger(__name__)

T = TypeVar("T")


def get_client() -> "Any | None":
    """공용 async Redis 클라이언트(event_broker 싱글턴 재사용). redis_url 미설정 시 None.

    신규 연결을 만들지 않는다 — event_broker._get_redis_client() 의 lazy 싱글턴을 그대로 쓴다.
    """
    if not settings.redis_url:
        return None
    # 지연 import — event_broker 로딩/순환참조 회피.
    from app.services.event_broker import _get_redis_client

    return _get_redis_client()


def key(domain: str, *parts: str) -> str:
    """env-scoped 네임스페이스 키: sprintable:{env}:{domain}:{parts…}."""
    env = getattr(settings, "app_env", None) or "dev"
    return ":".join(["sprintable", str(env), domain, *[str(p) for p in parts]])


async def with_fallback(
    redis_op: Callable[[Any], Awaitable[T]], fallback: Callable[[], T]
) -> T:
    """Redis 연산 시도 → 실패(클라이언트 None·연결/명령 에러) 시 도메인이 준 fallback 호출.

    정책(fail-open/closed)은 fallback 구현이 결정한다 — 공용층은 "Redis 안 되면 fallback" 만 보장.
    presence 는 fallback=in-memory 로 fail-open(끊지 않고 파편화 감수).
    """
    client = get_client()
    if client is None:
        return fallback()
    try:
        return await redis_op(client)
    except Exception:  # 연결/명령 실패 → 도메인 폴백(무회귀)
        logger.warning("redis_shared op failed → fallback", exc_info=True)
        return fallback()


# ── pub/sub 헬퍼(#2122 fanout 용·event_broker 패턴 승격) ────────────────────────
async def publish(channel: str, message: str) -> int | None:
    """채널에 발행. Redis 없으면 None(도메인이 local-only 폴백 처리)."""
    client = get_client()
    if client is None:
        return None
    return await client.publish(channel, message)
