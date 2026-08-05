"""story #2460(§6 봉합②): delivery_jobs 워커 — outbox(claim)와 배달(외부 I/O)을 분리한다.

PO 확定 설계(2026-08-05): enqueue는 caller의 요청 트랜잭션에 원자적으로 실리고(at-least-once
계약은 app/models/delivery_job.py·webhook_dispatch.py/notification_dispatch.py/expo_push.py의
``via_outbox=True`` 경로 참고), 이 워커가 commit 後 별도 폴링으로 실제 webhook POST/Expo push를
수행한다.

⚠️embedding_backlog.py/event_broker.outbox_dispatcher_loop()와 달리 이 워커는 claim(FOR UPDATE
SKIP LOCKED)과 실 배달(외부 I/O)을 **분리**한다 — claim은 즉시 commit해 lock을 놓고, 각 job은
자기 세션으로 배달+상태갱신까지 짧게 마친다. 다건 webhook POST를 하나의 열린 트랜잭션 아래서
순회하지 않는다 — 개별 webhook당 최대 10s 타임아웃이 걸릴 수 있어, 그걸 열린 트랜잭션 안에서
하면 §6이 막 닫은 "커넥션을 오래 쥔 채 외부 I/O" 클래스를 이 워커 자신이 재현하게 된다(PO
2026-08-05 명시 지시 — "worker loop은 세션 짧게 잡고, 외부 I/O 中 트랜잭션 안 잡게").

claim은 진짜 락이 아니다(attempts만 증가시키고 status는 pending 그대로 둔다) — FOR UPDATE
SKIP LOCKED는 claim 트랜잭션이 열려 있는 "그 순간"의 동시 폴링만 막고, 그 트랜잭션이 끝난
뒤 재폴링까지는 못 막는다. 즉 두 인스턴스가 좁은 창 안에서 겹치면 같은 job을 중복 배달할 수
있다 — AC가 명시 허용하는 범위(at-least-once, exactly-once 아님)라 의도적으로 더 무거운 락은
안 쓴다.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update

logger = logging.getLogger(__name__)

_BATCH_SIZE = 20
_POLL_INTERVAL = 2.0  # AC "near-real-time cadence" — event_broker.outbox_dispatcher_loop() 1s와 동급대.
_MAX_ATTEMPTS = 5
_CONCURRENCY = 5  # 배치 내 job들을 짧은 세션끼리 병렬 배달(커넥션 풀 예산 고려한 상한).


async def _claim_batch(limit: int = _BATCH_SIZE) -> list[dict]:
    """FOR UPDATE SKIP LOCKED로 pending job 배치를 골라 attempts만 증가시키고 바로 commit —
    lock을 짧게만 쥔다(배달은 여기서 안 함). 반환은 세션-독립적인 순수 dict라 다음 단계가 이
    세션을 물고 다닐 필요가 없다."""
    from app.core.database import async_session_factory
    from app.models.delivery_job import DeliveryJob

    async with async_session_factory() as session:
        rows = (await session.execute(
            select(DeliveryJob)
            .where(DeliveryJob.status == "pending")
            .order_by(DeliveryJob.created_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )).scalars().all()
        if not rows:
            await session.commit()
            return []
        claimed = [
            {"id": r.id, "org_id": r.org_id, "kind": r.kind, "payload": dict(r.payload), "attempts": r.attempts}
            for r in rows
        ]
        await session.execute(
            update(DeliveryJob)
            .where(DeliveryJob.id.in_([r["id"] for r in claimed]))
            .values(attempts=DeliveryJob.attempts + 1)
        )
        await session.commit()
        return claimed


def _uuid_or_none(v: str | None) -> uuid.UUID | None:
    return uuid.UUID(v) if v else None


def _uuid_set_or_none(v: list[str] | None) -> set[uuid.UUID] | None:
    return {uuid.UUID(m) for m in v} if v is not None else None


async def _deliver_one(job: dict) -> None:
    """claim된 job 하나를 자기 세션으로 배달 + 상태갱신(이 함수 호출 동안만 커넥션 보유).

    개별 webhook/push target 실패는 각 ``_now`` 함수 내부가 이미 삼킨다(기존 in-request 동작과
    동일 best-effort — per-target 실패는 job 레벨에는 안 보임). 여기서 "실패"로 잡는 경우는 이
    함수 자체가 예외를 낸 경우뿐(DB 조회 실패·payload 역직렬화 오류·미지원 kind 등)."""
    from app.core.database import async_session_factory
    from app.models.delivery_job import DeliveryJob

    job_id = job["id"]
    org_id = job["org_id"]
    kind = job["kind"]
    payload = job["payload"]
    attempts = job["attempts"] + 1  # claim에서 이미 +1 커밋됨 — 로컬에서도 동일 값 반영.

    try:
        async with async_session_factory() as session:
            if kind == "org_webhook":
                from app.services.webhook_dispatch import _fire_webhooks_now

                await _fire_webhooks_now(
                    session, org_id, payload["event"], payload["data"],
                    recipient_member_ids=_uuid_set_or_none(payload.get("recipient_member_ids")),
                    preserve_broadcast=payload.get("preserve_broadcast", True),
                )
            elif kind == "personal_webhook":
                from app.services.notification_dispatch import _deliver_personal_webhooks_now

                await _deliver_personal_webhooks_now(
                    session, org_id, [uuid.UUID(m) for m in payload["member_ids"]],
                    title=payload["title"], body=payload.get("body"), event_type=payload["event_type"],
                    reference_type=payload.get("reference_type"),
                    reference_id=_uuid_or_none(payload.get("reference_id")),
                    context=payload.get("context"),
                    muted_member_ids=_uuid_set_or_none(payload.get("muted_member_ids")),
                )
            elif kind == "expo_push":
                from ee.services.expo_push import _deliver_expo_push_now

                await _deliver_expo_push_now(
                    session, org_id, [uuid.UUID(m) for m in payload["member_ids"]],
                    title=payload["title"], body=payload.get("body"), event_type=payload["event_type"],
                    reference_type=payload.get("reference_type"),
                    reference_id=_uuid_or_none(payload.get("reference_id")),
                    context=payload.get("context"),
                    muted_member_ids=_uuid_set_or_none(payload.get("muted_member_ids")),
                    project_id=_uuid_or_none(payload.get("project_id")),
                    story_id=_uuid_or_none(payload.get("story_id")),
                    sprint_id=_uuid_or_none(payload.get("sprint_id")),
                )
            else:
                raise ValueError(f"unknown delivery_job kind: {kind}")

            await session.execute(
                update(DeliveryJob).where(DeliveryJob.id == job_id).values(
                    status="delivered", delivered_at=datetime.now(timezone.utc),
                )
            )
            await session.commit()
    except Exception as exc:
        logger.warning("delivery_dispatcher: job %s (kind=%s) delivery attempt failed: %s", job_id, kind, exc)
        try:
            async with async_session_factory() as session:
                # embedding_backlog.py의 retry_count 임계값과 동형 — _MAX_ATTEMPTS 도달 시
                # terminal(다음 tick부터 status='pending' SELECT에서 영구 제외).
                next_status = "pending" if attempts < _MAX_ATTEMPTS else "failed"
                await session.execute(
                    update(DeliveryJob).where(DeliveryJob.id == job_id).values(
                        status=next_status, last_error=str(exc)[:1000],
                    )
                )
                await session.commit()
        except Exception:
            logger.exception("delivery_dispatcher: job %s status update after failure also failed", job_id)


async def delivery_dispatcher_loop() -> None:
    """claim(짧은 트랜잭션) → 배달(짧은 세션, 외부 I/O) → 상태갱신을 tick마다 반복.

    정상 tick 사이 ``_POLL_INTERVAL`` 고정 폴링. listen_loop()/event_broker.outbox_dispatcher_loop()
    와 동형 에러 backoff(1s→2s→...→30s)."""
    logger.info(
        "delivery_dispatcher starting (poll_interval=%.1fs batch=%d concurrency=%d)",
        _POLL_INTERVAL, _BATCH_SIZE, _CONCURRENCY,
    )
    delay = 1.0
    while True:
        try:
            claimed = await _claim_batch()
            if not claimed:
                await asyncio.sleep(_POLL_INTERVAL)
                delay = 1.0
                continue
            for i in range(0, len(claimed), _CONCURRENCY):
                chunk = claimed[i:i + _CONCURRENCY]
                await asyncio.gather(*(_deliver_one(j) for j in chunk))
            delay = 1.0
        except asyncio.CancelledError:
            logger.info("delivery_dispatcher cancelled — shutting down")
            break
        except Exception as exc:
            logger.warning("delivery_dispatcher error: %s — retrying in %.1fs", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
