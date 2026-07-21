"""E-ARCH S2/S3(story #2078): EventBroker — PG NOTIFY(authoritative) + Redis dual-publish,
단계적으로 Redis를 실 dispatch 경로로 승격.

설계(오르테가군 판정 2026-07-21): 2단계는 dual-publish, 3단계에서 Redis-only 구현체로 교체 가능
하도록 `EventBroker`를 인터페이스로 분리한다 — 콜사이트(events.py)는 어느 구현체가 도는지 모른다.

Redis 발행 경로는 `event_broker_redis_dual_publish_enabled`(default False)로 게이트 — 꺼져
있으면 이 모듈은 `pg_notify()` 호출 외 아무것도 안 한다(무회귀, #2358 PG_LISTEN_ENABLED와 동일
컨벤션).

⚠️근본 정정(2026-07-21, 착수 전 확認): 처음엔 Redis 수신이 "shadow"(관측 전용 — PG 대비 도달률/
지연만 로그, 실제 SSE 전달은 안 함)이었다. 그 상태로 PG LISTEN을 걷으면 Redis는 발행되는데
아무도 안 받아 실시간이 전면 정지했을 것 — "도달 확認"과 "전달 확認"은 다른 것이었다.
`event_broker_redis_dispatch_enabled`(default False, 별개 게이트)가 켜져야 `redis_consume_loop`
가 `publish_event()`/`_push_to_agent()`를 실제로 호출해 SSE로 전달한다(self-skip 포함,
pg_pubsub._dispatch_received와 동형) — 이게 켜져야 비로소 PG_LISTEN_ENABLED=false(LISTEN
제거)가 안전해진다. dual_publish만 켜진 상태(dispatch 꺼짐)는 여전히 순수 관측이라 무회귀 —
PG LISTEN이 유일한 실 dispatch 경로. 근거(관측 유실 허용 근거는 유지): agent_gateway.py의
acked_seq DB 재조회 패턴과 동형 — wake 신호 유실은 다음 재조회가 흡수한다(2026-07-21 세션
코드 교차검증 완료). 단 이 근거는 "dispatch가 이미 이뤄지는데 신호만 놓쳐도 안전하다"는
것이지 "dispatch 자체가 없어도 안전하다"는 뜻이 아니다 — 이번 정정이 그 구분을 명확히 한다.
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
    """Redis 발행 — 실패 시 경고 로그만(pg_notify와 동형 철학: shadow 경로라 예외 전파 금지).

    payload는 pg_notify()와 동형 envelope(instance_id/target/target_id/event_type/data 분리) —
    자기발행 self-skip(story #2078 실 dispatch 승격)과 수신측 파싱을 pg_pubsub._dispatch_received()
    와 대칭으로 유지한다. instance_id는 pg_pubsub.INSTANCE_ID 재사용(같은 프로세스=같은 값).
    """
    import json

    from app.core.config import settings
    from app.services.pg_pubsub import INSTANCE_ID

    if not settings.redis_url:
        logger.warning("event_broker redis publish skipped: redis_url not configured")
        return

    inner = _slim_org_payload(data) if target == "org" else dict(data)
    payload = {
        "instance_id": INSTANCE_ID,
        "target": target,
        "target_id": target_id,
        "event_type": event_type,
        "_broker_event_id": event_id,
        "data": inner,
    }

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


async def _resolve_org_id(target: Literal["org", "agent"], target_id: str, data: dict) -> uuid.UUID | None:
    """outbox row의 org_id(NOT NULL) 확보 — 우선순위: (1) payload에 이미 있으면 그대로
    (org-target 대부분이 여기 해당) (2) agent-target은 payload에 org_id가 없는 경우가 많아
    member 조회 — #2075(story #2075 owner SSE parity)에서 확立된 대로 member_id 축이
    `team_members.id`뿐 아니라 grant-only 휴먼은 `org_members.id`로도 해소되므로 UNION 조회.
    둘 다 실패하면 None(호출부가 skip+경고 로그, outbox insert는 best-effort라 예외 전파 금지)."""
    if target == "org":
        try:
            return uuid.UUID(target_id)
        except ValueError:
            pass

    raw = data.get("org_id")
    if raw:
        try:
            return uuid.UUID(str(raw))
        except ValueError:
            pass

    try:
        from sqlalchemy import text as _sa_text

        from app.core.database import async_session_factory

        async with async_session_factory() as session:
            row = (
                await session.execute(
                    _sa_text(
                        "SELECT org_id FROM team_members WHERE id = :tid "
                        "UNION SELECT org_id FROM org_members WHERE id = :tid LIMIT 1"
                    ),
                    {"tid": target_id},
                )
            ).first()
            return row[0] if row else None
    except Exception as exc:
        logger.warning("event_broker org_id resolve failed target_id=%s: %s", target_id, exc)
        return None


async def _insert_outbox_row(
    target: Literal["org", "agent"], target_id: str, event_type: str, data: dict
) -> None:
    """event_outbox row insert — best-effort(별도 짧은 트랜잭션, caller의 commit과 atomic 아님).

    3a단계 스코프: 실패해도 예외를 삼킨다(경고 로그만) — outbox가 아직 dispatch의 유일 경로가
    아니라(PG NOTIFY가 여전히 authoritative) insert 실패가 실시간 전달 자체를 막으면 안 된다.
    """
    org_id = await _resolve_org_id(target, target_id, data)
    if org_id is None:
        logger.warning(
            "event_broker outbox insert skipped (org_id unresolved) target=%s target_id=%s event_type=%s",
            target, target_id, event_type,
        )
        return

    try:
        from app.core.database import async_session_factory
        from app.models.event_outbox import EventOutbox

        async with async_session_factory() as session:
            session.add(
                EventOutbox(
                    org_id=org_id,
                    target=target,
                    target_id=uuid.UUID(target_id),
                    event_type=event_type,
                    payload=data,
                )
            )
            await session.commit()
    except Exception as exc:
        logger.warning(
            "event_broker outbox insert failed target=%s target_id=%s: %s", target, target_id, exc
        )


class OutboxEventBroker:
    """E-ARCH S3 3a단계 구현체 — `DualPublishEventBroker`(PG NOTIFY+Redis shadow) 위에
    `event_outbox` row insert만 추가한다. 호출 타이밍은 3a에서 바뀌지 않는다(여전히 caller
    commit 이후) — 3b에서 콜사이트가 db 세션을 넘기게 되면 이 클래스의 publish 시그니처를
    확장해 진짜 atomic insert로 바꿀 것(지금은 조기 확장 금지).

    `event_broker_outbox_enabled`(default False)로 게이트 — 꺼져 있으면 inner(2단계) 동작만
    그대로, insert 자체가 아예 시도되지 않는다(무회귀).
    """

    def __init__(self, inner: EventBroker | None = None):
        self._inner = inner or DualPublishEventBroker()

    async def publish(
        self, target: Literal["org", "agent"], target_id: str, event_type: str, data: dict
    ) -> None:
        await self._inner.publish(target, target_id, event_type, data)

        from app.core.config import settings

        if settings.event_broker_outbox_enabled:
            await _insert_outbox_row(target, target_id, event_type, data)


# events.py 콜사이트가 참조하는 싱글턴 — OutboxEventBroker가 DualPublishEventBroker(2단계)를
# 감싸는 형태라 콜사이트 변경 없이 3a가 얹힌다(event_broker_outbox_enabled=False면 완전 무회귀).
event_broker: EventBroker = OutboxEventBroker()


# ─── Shadow-consume 비교 (realtime gateway 전용) ──────────────────────────────

def record_pg_arrival(event_id: str) -> None:
    """pg_pubsub._dispatch_received()가 PG 경로로 이벤트 도착 시 호출 — shadow 비교 기준점."""
    if not event_id:
        return
    if len(_pg_arrivals) >= _SHADOW_MAX_TRACKED:
        for key in list(_pg_arrivals)[: _SHADOW_MAX_TRACKED // 2]:
            _pg_arrivals.pop(key, None)
    _pg_arrivals[event_id] = time.monotonic()


async def redis_consume_loop() -> None:
    """Redis 구독 → (a) PG 경로 도착 기록과 대조해 지연Δ·중복률 로그(항상) (b)
    `event_broker_redis_dispatch_enabled`(default False)가 켜지면 실제로
    `publish_event()`/`_push_to_agent()`를 호출해 SSE로 전달(실 dispatch 승격).

    ⚠️ story #2078 근본 정정(2026-07-21, 착수 전 확認): 원래 "shadow-consume"이라는 이름대로
    관측만 했다 — Redis가 PG만큼 "도달"하는지는 쟀지만 그 도달이 실제로 SSE 큐까지 "전달"되는
    지는 재지 않았다(publish_event/_push_to_agent 호출 자체가 코드에 없었다). 그 상태에서 PG
    LISTEN을 걷으면 Redis 발행은 되는데 아무도 안 받아 실시간이 전면 정지했을 것 — 이 함수가
    바로 그 갭을 닫는다. dispatch_enabled=False인 동안은 순수 관측(무회귀, 기존 이름의 "shadow"
    의미 그대로 유지) — 켜지면 pg_pubsub._dispatch_received()와 동형으로 실 전달까지 한다.

    self-skip: payload.instance_id(자기 자신이 발행한 이벤트)면 skip — PG NOTIFY의 동일 로직과
    대칭(_dispatch_received). ⚠️outbox_dispatcher_loop 발행분은 instance_id=None이라 self-skip
    신호가 없다 — event_broker_outbox_enabled와 dispatch_enabled를 동시에 켜면 중복 dispatch
    위험(3b에서 해소 예정, 그 전까지 둘을 동시에 켜지 말 것).

    listen_loop()(pg_pubsub.py)과 동형 재연결 구조(1s→2s→4s→max 30s backoff).
    """
    import json

    from app.core.config import settings
    from app.services.pg_pubsub import INSTANCE_ID

    if not settings.redis_url:
        logger.warning("event_broker redis consume skipped: redis_url not configured")
        return

    delay = 1.0
    logger.info("event_broker redis consume starting (dispatch_enabled=%s)", settings.event_broker_redis_dispatch_enabled)

    while True:
        pubsub = None
        try:
            client = _get_redis_client()
            pubsub = client.pubsub()
            await pubsub.psubscribe("org:*:invalidation", "agent:*")
            delay = 1.0
            logger.info("event_broker redis consume connected")
            async for message in pubsub.listen():
                if message.get("type") not in ("pmessage", "message"):
                    continue
                try:
                    payload = json.loads(message["data"])
                except (TypeError, ValueError):
                    continue

                event_id = payload.get("_broker_event_id")
                if event_id:
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

                if not settings.event_broker_redis_dispatch_enabled:
                    continue

                if payload.get("instance_id") == INSTANCE_ID:
                    continue  # 자기 자신이 발행한 이벤트 skip(_dispatch_received 동형)

                target = payload.get("target")
                target_id = str(payload.get("target_id", ""))
                event_type = str(payload.get("event_type", ""))
                data = payload.get("data") or {}
                try:
                    from app.routers.events import _push_to_agent, publish_event
                    if target == "org":
                        publish_event(target_id, event_type, data, _from_listener=True)
                    elif target == "agent":
                        _push_to_agent(target_id, data, _from_listener=True)
                except Exception as exc:
                    logger.warning("event_broker redis dispatch failed target=%s: %s", target, exc)
        except asyncio.CancelledError:
            logger.info("event_broker redis consume cancelled — shutting down")
            break
        except Exception as exc:
            logger.warning(
                "event_broker redis consume error: %s — reconnecting in %.1fs", exc, delay
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
        finally:
            if pubsub is not None:
                try:
                    await pubsub.close()
                except Exception:
                    pass


# ─── Outbox dispatcher (realtime gateway 전용, event_broker_outbox_enabled 게이트) ────────

_OUTBOX_BATCH_SIZE = 50
_OUTBOX_POLL_INTERVAL = 1.0


async def outbox_dispatcher_loop() -> None:
    """`event_outbox`의 미발행 row를 폴링해 Redis로 발행 — 3a단계 dispatcher.

    `FOR UPDATE SKIP LOCKED`로 멀티인스턴스 동시 폴링 시 중복발행을 방지한다(표준 outbox
    패턴). listen_loop()/redis_consume_loop()와 동형 에러 backoff(1s→2s→...→30s) —
    정상 시엔 고정 폴링 간격(`_OUTBOX_POLL_INTERVAL`)으로 반복한다.

    ⚠️ `event_broker_redis_dual_publish_enabled`와 `event_broker_outbox_enabled`를 동시에
    켜면 같은 논리적 이벤트가 Redis에 두 번(즉시 shadow-publish + 나중 outbox dispatch) 발행될
    수 있다 — 서로 다른 `_broker_event_id`를 쓰기 때문에(즉시 경로는 uuid4, outbox 경로는
    row.id) dedup도 안 된다. 의도된 설계다: outbox는 dual-publish를 **대체**하는 것이지
    병행하는 게 아니다(오르테가군 시퀀싱 — dual-publish→shadow-consume→outbox 전환→LISTEN
    제거는 순차, 동시 아님). 두 플래그를 동시에 켜는 것은 3b 전환 실험 용도가 아니면 피할 것.
    """
    import json
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.core.config import settings
    from app.core.database import async_session_factory
    from app.models.event_outbox import EventOutbox

    if not settings.redis_url:
        logger.warning("event_broker outbox dispatcher skipped: redis_url not configured")
        return

    delay = 1.0
    logger.info("event_broker outbox dispatcher starting")

    while True:
        try:
            async with async_session_factory() as session:
                rows = (
                    await session.execute(
                        select(EventOutbox)
                        .where(EventOutbox.published_at.is_(None))
                        .order_by(EventOutbox.id)
                        .limit(_OUTBOX_BATCH_SIZE)
                        .with_for_update(skip_locked=True)
                    )
                ).scalars().all()

                if not rows:
                    await session.commit()
                    await asyncio.sleep(_OUTBOX_POLL_INTERVAL)
                    continue

                client = _get_redis_client()
                now = datetime.now(timezone.utc)
                for row in rows:
                    inner = _slim_org_payload(row.payload) if row.target == "org" else dict(row.payload)
                    # pg_notify()/_redis_publish()와 동형 envelope(파싱 대칭) — instance_id는
                    # 의도적으로 None: outbox row는 폴링한 인스턴스가 원발행 인스턴스와 다를 수
                    # 있어(dispatcher가 어느 인스턴스에서 돌든 같은 DB row를 픽업) 신뢰 가능한
                    # self-skip 신호가 없다. ⚠️알려진 갭(3b에서 해소 예정) — 이 경로가 아직 실
                    # dispatch로 승격 안 된 이유이기도 하다(event_broker_redis_dispatch_enabled
                    # 를 outbox_enabled와 함께 켜면 self-skip 누락으로 인한 중복 dispatch 위험).
                    payload = {
                        "instance_id": None,
                        "target": row.target,
                        "target_id": str(row.target_id),
                        "event_type": row.event_type,
                        "_broker_event_id": str(row.id),
                        "data": inner,
                    }
                    try:
                        await client.publish(
                            _redis_channel(row.target, str(row.target_id)),
                            json.dumps(payload, default=str),
                        )
                    except Exception as exc:
                        logger.warning(
                            "event_broker outbox dispatch publish failed id=%s: %s", row.id, exc
                        )
                        continue  # published_at 미갱신 — 다음 폴링에서 재시도(at-least-once)
                    row.published_at = now

                await session.commit()
            delay = 1.0
        except asyncio.CancelledError:
            logger.info("event_broker outbox dispatcher cancelled — shutting down")
            break
        except Exception as exc:
            logger.warning(
                "event_broker outbox dispatcher error: %s — retrying in %.1fs", exc, delay
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
