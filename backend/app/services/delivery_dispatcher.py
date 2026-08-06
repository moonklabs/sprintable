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
    """claim된 job 하나를 배달 + 상태갱신.

    story #2460 PO 리뷰(2026-08-05, F1 — 머지 前 필수수정): 예전엔 이 함수 전체가 하나의
    `async with async_session_factory() as session:` 블록 안에서 fetch도 하고 실제
    webhook POST/Expo 발송(외부 I/O, 타깃당 최대 10s)까지 다 했다 — POST 자체는 session을
    안 건드리지만 그 세션(커넥션)이 POST 루프 내내 idle-in-transaction으로 열려 있었다("배달
    中 트랜잭션 안 잡는다"는 클래스 docstring 계약과 실제가 어긋난 한 겹 얕은 원본). 지금은
    kind별로 **fetch(짧은 세션, 즉시 commit)→send(세션 없음, 순수 외부 I/O)→[expo_push만:
    finalize(짧은 세션)]** 세 단계로 명시 분리 — 세션이 열려 있는 구간과 외부 I/O 구간이
    절대 겹치지 않는다.

    개별 webhook/push target 실패는 각 ``_send_*`` 함수 내부가 이미 삼킨다(기존 in-request
    동작과 동일 best-effort — per-target 실패는 job 레벨에는 안 보임). 여기서 "실패"로 잡는
    경우는 fetch/finalize의 DB 오류·payload 역직렬화 오류·미지원 kind 등 이 함수 자체가
    예외를 낸 경우뿐."""
    from app.core.database import async_session_factory
    from app.models.delivery_job import DeliveryJob

    job_id = job["id"]
    org_id = job["org_id"]
    kind = job["kind"]
    payload = job["payload"]
    attempts = job["attempts"] + 1  # claim에서 이미 +1 커밋됨 — 로컬에서도 동일 값 반영.

    try:
        if kind == "org_webhook":
            from app.services.webhook_dispatch import _fetch_webhook_targets, _send_webhook_targets

            async with async_session_factory() as session:
                targets = await _fetch_webhook_targets(
                    session, org_id, payload["event"],
                    recipient_member_ids=_uuid_set_or_none(payload.get("recipient_member_ids")),
                    preserve_broadcast=payload.get("preserve_broadcast", True),
                )
                await session.commit()
            # ⬇ 이 구간은 세션이 닫혀 있다(커넥션 풀에 반납됨) — 외부 I/O만.
            await _send_webhook_targets(targets, payload["event"], payload["data"])
        elif kind == "personal_webhook":
            from app.services.notification_dispatch import (
                _fetch_personal_webhook_targets,
                _send_personal_webhook_targets,
            )

            async with async_session_factory() as session:
                targets = await _fetch_personal_webhook_targets(
                    session, org_id, [uuid.UUID(m) for m in payload["member_ids"]],
                    muted_member_ids=_uuid_set_or_none(payload.get("muted_member_ids")),
                )
                await session.commit()
            await _send_personal_webhook_targets(
                targets, title=payload["title"], body=payload.get("body"),
                event_type=payload["event_type"], reference_type=payload.get("reference_type"),
                reference_id=_uuid_or_none(payload.get("reference_id")), context=payload.get("context"),
            )
        elif kind == "expo_push":
            from ee.services.expo_push import (
                _fetch_expo_push_targets,
                _finalize_expo_push_dead_tokens,
                _send_expo_push_targets,
            )

            async with async_session_factory() as session:
                targets = await _fetch_expo_push_targets(
                    session, org_id, [uuid.UUID(m) for m in payload["member_ids"]],
                    muted_member_ids=_uuid_set_or_none(payload.get("muted_member_ids")),
                )
                await session.commit()
            dead_tokens = await _send_expo_push_targets(
                targets, title=payload["title"], body=payload.get("body"),
                event_type=payload["event_type"], org_id=org_id,
                reference_type=payload.get("reference_type"),
                reference_id=_uuid_or_none(payload.get("reference_id")),
                project_id=_uuid_or_none(payload.get("project_id")),
                story_id=_uuid_or_none(payload.get("story_id")),
                sprint_id=_uuid_or_none(payload.get("sprint_id")),
            )
            if dead_tokens:
                async with async_session_factory() as session:
                    await _finalize_expo_push_dead_tokens(session, org_id, dead_tokens)
                    await session.commit()
        else:
            raise ValueError(f"unknown delivery_job kind: {kind}")

        async with async_session_factory() as session:
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
