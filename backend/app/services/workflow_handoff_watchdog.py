"""E-DECISION-GATE S8: handoff watchdog + ACK reconciliation (P0-3 마무리).

S7 가 agent-handoff relay 의 delivery_status 를 기록(queued)했으니, S8 watchdog 가 주기적으로:
- agent ACK cursor(``AgentEventCursor.acked_seq``)와 대사 → ACK 됐으면 ``delivery_status='acked'``.
- 10분 초과 미ACK → ``delivery_status='timed_out'``(board badge) + fallback human notification.
silent handoff stall 을 observable incident 로 전환한다.

설계(산티아고 ACK/connector SME 사인오프):
- recipient 는 ``step_run.event_id → Event.recipient_id`` 로 해소(Event = source of truth·resolved_member_id
  백필 안 함).
- ⭐wake 성공 ≠ delivered: S7 의 queued 를 그대로 두고 ACK cursor 로만 acked 판정.
- 신규 EventType 0(``dispatch_notification`` 의 notification 카테고리만 사용).
- idempotent: queued/delivered 만 픽 → acked/timed_out 전환 즉시 재처리·재notify 제외.
- 방어: event 없음→missing_dispatch_event·recipient_type≠agent→ACK skip·recipient_seq null→missing_recipient_seq.
- dispatch_notification 실패는 watchdog 전체 실패로 올리지 않고 해당 run best-effort 후 계속.
- workflow_step_run_events phase 행은 모델 부재로 S8 범위 밖(관측성 S9+)·delivery_status/error 로 충분.
"""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_gateway import AgentEventCursor
from app.models.event import Event
from app.models.workflow_line import WorkflowLineStepRun

_OPEN_DELIVERY = ("queued", "delivered")
DEFAULT_STUCK_MINUTES = 10


async def _fallback_notify(session: AsyncSession, sr: WorkflowLineStepRun,
                           recipient_id: uuid.UUID | None) -> None:
    """stuck handoff 의 fallback human notification(best-effort·실패는 삼킴)."""
    if recipient_id is None:
        return
    try:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=sr.org_id, event_type="handoff_stuck",
            target_member_ids=[recipient_id],
            title="Handoff stalled — no ACK within SLA",
            body=f"{sr.entity_type} {sr.entity_id} {sr.from_status}→{sr.to_status} handoff unacked",
            reference_type=sr.entity_type, reference_id=sr.entity_id,
        )
    except Exception:  # noqa: BLE001 — notification 실패는 watchdog 비중단(best-effort).
        sr.delivery_error = (sr.delivery_error or "") + "; notify_failed"


async def reconcile_handoffs(
    session: AsyncSession, now: datetime | None = None, stuck_after_minutes: int = DEFAULT_STUCK_MINUTES,
) -> dict[str, int]:
    """미해소 handoff step_run 을 ACK 대사·stuck 판정한다. 반환: 카운트."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=stuck_after_minutes)
    rows = (await session.execute(
        select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.delivery_status.in_(_OPEN_DELIVERY),
            WorkflowLineStepRun.created_at < cutoff,
        )
    )).scalars().all()

    acked = stuck = missing = 0
    for sr in rows:
        try:
            # 방어: dispatch event 없음 → ACK 대사 불가. 진단 남기고 stuck 처리(idempotent 전환).
            if sr.event_id is None:
                sr.delivery_status = "timed_out"
                sr.delivery_error = "missing_dispatch_event"
                sr.failure_class = "schema_gap"
                missing += 1
                continue
            event = (await session.execute(
                select(Event).where(Event.id == sr.event_id)
            )).scalar_one_or_none()
            if event is None:
                sr.delivery_status = "timed_out"
                sr.delivery_error = "missing_dispatch_event"
                sr.failure_class = "schema_gap"
                missing += 1
                continue

            recipient_id = event.recipient_id
            # recipient_type != agent → ACK cursor 대상 아님 → 미ACK 인 채 SLA 초과면 stuck(human fallback).
            if event.recipient_type == "agent" and sr.recipient_seq is not None:
                cursor = (await session.execute(
                    select(AgentEventCursor).where(AgentEventCursor.agent_id == recipient_id)
                )).scalar_one_or_none()
                if cursor is not None and cursor.acked_seq >= sr.recipient_seq:
                    sr.delivery_status = "acked"  # ⭐ACK 대사 성공(notification 불요)
                    acked += 1
                    continue
            elif event.recipient_type == "agent" and sr.recipient_seq is None:
                sr.delivery_error = "missing_recipient_seq"  # ACK 비교 불가·가시화

            # 미ACK·SLA 초과 → stuck(board badge) + fallback notification.
            sr.delivery_status = "timed_out"
            await _fallback_notify(session, sr, recipient_id)
            stuck += 1
        except Exception as exc:  # noqa: BLE001 — run 단위 실패는 watchdog 비중단(다음 run 계속).
            sr.delivery_error = f"watchdog: {str(exc)[:200]}"

    await session.commit()
    return {"acked": acked, "stuck": stuck, "missing_event": missing, "scanned": len(rows)}
