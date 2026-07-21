"""E-ARCH S2(story #2078): EventBroker — PG NOTIFY(authoritative) + Redis(shadow dual-publish).

설계(오르테가군 판정 2026-07-21): 2단계는 dual-publish, 3단계에서 Redis-only 구현체로 교체 가능
하도록 `EventBroker`를 인터페이스로 분리한다 — 콜사이트(events.py)는 어느 구현체가 도는지 모른다.

Redis 경로는 `event_broker_redis_dual_publish_enabled`(default False)로 게이트 — 꺼져 있으면
이 모듈은 `pg_notify()` 호출 외 아무것도 안 한다(무회귀, #2358 PG_LISTEN_ENABLED와 동일 컨벤션).

Redis가 이 단계에서 100% 유실돼도 정합성 영향 0 — Redis는 realtime gateway의 shadow-consume
비교(지연·중복률 측정)용일 뿐 dispatch에 쓰이지 않는다. dispatch는 여전히 PG LISTEN
(pg_pubsub.listen_loop) 경로만 탄다. 근거: agent_gateway.py의 acked_seq DB 재조회 패턴과 동형
— wake 신호 유실은 다음 재조회가 흡수한다(2026-07-21 세션 코드 교차검증 완료).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Literal, Protocol

logger = logging.getLogger(__name__)

_REDIS_CHANNEL_PREFIX_ORG = "org"
_REDIS_CHANNEL_PREFIX_AGENT = "agent"

# shadow-consume 비교용 — PG 경로로 도착한 event_id → 도착 시각(monotonic). 크기 상한으로
# 무한증가 방지(정밀 LRU 불필요 — shadow 비교는 근사치 지표면 충분, 비교 실패해도 dispatch 무영향).
_SHADOW_MAX_TRACKED = 2000
_pg_arrivals: dict[str, float] = {}

_redis_client = None  # lazy singleton — redis_url 미설정 시(Memorystore 없음) 절대 생성 안 함


class EventBroker(Protocol):
    async def publish(
        self, target: Literal["org", "agent"], target_id: str, event_type: str, data: dict
    ) -> None: ...


def _slim_org_payload(data: dict) -> dict:
    """org-wide invalidation 전용 슬림 payload — 민감 content 방송 금지(FE가 권한검증 REST 재조회).

    ⚠️ 이 슬림화는 신규 Redis 경로에만 적용된다 — 기존 PG NOTIFY org 채널 payload(및
    `publish_event()`의 `_subscribers` 로컬 in-process fanout)는 안 건드림(기존 컨슈머 무영향).
    """
    return {
        "entity_type": data.get("entity_type"),
        "entity_id": data.get("entity_id"),
        "version": data.get("version"),
    }


def _redis_channel(target: Literal["org", "agent"], target_id: str) -> str:
    if target == "org":
        return f"{_REDIS_CHANNEL_PREFIX_ORG}:{target_id}:invalidation"
    return f"{_REDIS_CHANNEL_PREFIX_AGENT}:{target_id}"


def _get_redis_client():
    global _redis_client
    if _redis_client is None:
        import redis.asyncio as aioredis

        from app.core.config import settings

        _redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


async def _redis_publish(
    target: Literal["org", "agent"], target_id: str, event_type: str, data: dict, event_id: str
) -> None:
    """Redis 발행 — 실패 시 경고 로그만(pg_notify와 동형 철학: shadow 경로라 예외 전파 금지)."""
    import json

    from app.core.config import settings

    if not settings.redis_url:
        logger.warning("event_broker redis publish skipped: redis_url not configured")
        return

    payload = _slim_org_payload(data) if target == "org" else dict(data)
    payload["event_type"] = event_type
    payload["_broker_event_id"] = event_id

    try:
        client = _get_redis_client()
        await client.publish(_redis_channel(target, target_id), json.dumps(payload, default=str))
    except Exception as exc:
        logger.warning(
            "event_broker redis publish failed target=%s target_id=%s: %s", target, target_id, exc
        )


class DualPublishEventBroker:
    """E-ARCH S2 구현체 — PG NOTIFY(authoritative, 무변경) + Redis(shadow, best-effort)."""

    async def publish(
        self, target: Literal["org", "agent"], target_id: str, event_type: str, data: dict
    ) -> None:
        from app.core.config import settings
        from app.services.pg_pubsub import fire_and_forget, pg_notify

        event_id = str(uuid.uuid4())
        # 기존 pg_notify 호출 그대로 — _broker_event_id만 추가(상관관계 ID, shadow 비교용).
        await pg_notify(target, target_id, event_type, {**data, "_broker_event_id": event_id})

        if settings.event_broker_redis_dual_publish_enabled:
            fire_and_forget(_redis_publish(target, target_id, event_type, data, event_id))


event_broker: EventBroker = DualPublishEventBroker()


# ─── Shadow-consume 비교 (realtime gateway 전용) ──────────────────────────────

def record_pg_arrival(event_id: str) -> None:
    """pg_pubsub._dispatch_received()가 PG 경로로 이벤트 도착 시 호출 — shadow 비교 기준점."""
    if not event_id:
        return
    if len(_pg_arrivals) >= _SHADOW_MAX_TRACKED:
        for key in list(_pg_arrivals)[: _SHADOW_MAX_TRACKED // 2]:
            _pg_arrivals.pop(key, None)
    _pg_arrivals[event_id] = time.monotonic()


async def redis_shadow_consume_loop() -> None:
    """Redis 구독 → PG 경로 도착 기록과 대조해 지연Δ·중복률을 로그.

    dispatch에는 절대 안 씀(PG가 여전히 authoritative) — 비교 관측 전용.
    listen_loop()(pg_pubsub.py)과 동형 재연결 구조(1s→2s→4s→max 30s backoff).
    """
    import json

    from app.core.config import settings

    if not settings.redis_url:
        logger.warning("event_broker redis shadow consume skipped: redis_url not configured")
        return

    delay = 1.0
    logger.info("event_broker redis shadow consume starting")

    while True:
        pubsub = None
        try:
            client = _get_redis_client()
            pubsub = client.pubsub()
            await pubsub.psubscribe("org:*:invalidation", "agent:*")
            delay = 1.0
            logger.info("event_broker redis shadow consume connected")
            async for message in pubsub.listen():
                if message.get("type") not in ("pmessage", "message"):
                    continue
                try:
                    payload = json.loads(message["data"])
                except (TypeError, ValueError):
                    continue
                event_id = payload.get("_broker_event_id")
                if not event_id:
                    continue
                received_at = time.monotonic()
                pg_arrived_at = _pg_arrivals.get(event_id)
                if pg_arrived_at is not None:
                    logger.info(
                        "event_broker shadow: redis+pg both delivered event_id=%s latency_delta=%.3fs",
                        event_id, received_at - pg_arrived_at,
                    )
                else:
                    logger.info(
                        "event_broker shadow: redis-only delivery event_id=%s (pg 미도착/유실 가능)",
                        event_id,
                    )
        except asyncio.CancelledError:
            logger.info("event_broker redis shadow consume cancelled — shutting down")
            break
        except Exception as exc:
            logger.warning(
                "event_broker redis shadow consume error: %s — reconnecting in %.1fs", exc, delay
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.close()
                except Exception:
                    pass
