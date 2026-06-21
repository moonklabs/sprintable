"""E-DECISION-GATE S15: line metrics + baseline instrumentation (P1-6).

Phase1 성공 측정 metric 을 step_run / step_run_events 에서 **read-only 집계**한다(라이브 무영향).
모든 집계는 aggregate SQL(func.count/case·group-by)로 — unbounded ``.all()`` 금지(S10 교훈)·org-
scoped·시간창 bounded. default-off org(라인 step_run 0)는 total 0 → 0/no-op 반환(AC④).
"""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepRunEvent

_HANDOFF_DELIVERY = ("queued", "delivered", "acked", "timed_out", "dead_letter",
                     "no_assignee", "unresolved_assignee")
_PENDING_GATE_STATUSES = ("waiting_gate", "waiting_parallel", "gate_pending", "reminded", "escalated", "held")
_BLOCKED_STATUSES = ("blocked", "blocked_by_policy")
_GRANDFATHER_STATUSES = ("grandfathered", "grandfathered_applied")
DEFAULT_WINDOW_DAYS = 14


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


async def compute_line_metrics(
    session: AsyncSession, org_id: uuid.UUID, window_days: int = DEFAULT_WINDOW_DAYS,
    now: datetime | None = None,
) -> dict:
    """org 의 line metric 집계(read-only·bounded·default-off org=0/no-op)."""
    now = now or _now()
    cutoff = now - timedelta(days=window_days)
    base = (WorkflowLineStepRun.org_id == org_id, WorkflowLineStepRun.started_at >= cutoff)

    def _c(cond):  # conditional count(단일 쿼리 내 case-sum)
        return func.sum(case((cond, 1), else_=0))

    row = (await session.execute(
        select(
            func.count().label("total"),
            _c(WorkflowLineStepRun.delivery_status.in_(_HANDOFF_DELIVERY)).label("handoff_total"),
            _c(WorkflowLineStepRun.delivery_status == "timed_out").label("stuck"),
            _c(WorkflowLineStepRun.delivery_status == "unresolved_assignee").label("unresolved"),
            _c(WorkflowLineStepRun.delivery_status == "acked").label("acked"),
            _c((WorkflowLineStepRun.degraded_to_plain.is_(True))
               | (WorkflowLineStepRun.status == "engine_failed")).label("degraded"),
            _c(WorkflowLineStepRun.status.in_(_BLOCKED_STATUSES)).label("blocked"),
            _c(WorkflowLineStepRun.status.in_(_GRANDFATHER_STATUSES)).label("grandfathered"),
            _c(WorkflowLineStepRun.mode == "advisory_only").label("advisory"),
        ).where(*base)
    )).one()

    total = int(row.total or 0)
    if total == 0:
        return {"org_id": str(org_id), "window_days": window_days, "total_step_runs": 0, "no_op": True}

    handoff_total = int(row.handoff_total or 0)

    # duplicate_pending_gate_count(=0 target): pending-gate 키 중복 그룹 수(uq 가 막지만 관측).
    dup = (await session.execute(
        select(func.count()).select_from(
            select(WorkflowLineStepRun.entity_id).where(
                *base, WorkflowLineStepRun.status.in_(_PENDING_GATE_STATUSES),
            ).group_by(
                WorkflowLineStepRun.entity_id, WorkflowLineStepRun.from_status,
                WorkflowLineStepRun.to_status, WorkflowLineStepRun.effective_gate_type,
            ).having(func.count() > 1).subquery()
        )
    )).scalar() or 0

    # step_run_events 집계(reminder/escalation/fallback).
    ev_rows = (await session.execute(
        select(WorkflowLineStepRunEvent.event_type, func.count()).where(
            WorkflowLineStepRunEvent.org_id == org_id,
            WorkflowLineStepRunEvent.created_at >= cutoff,
        ).group_by(WorkflowLineStepRunEvent.event_type)
    )).all()
    ev = {et: int(c) for et, c in ev_rows}

    return {
        "org_id": str(org_id),
        "window_days": window_days,
        "total_step_runs": total,
        "no_op": False,
        # ① Phase1 success metrics
        "handoff_stuck_rate": _rate(int(row.stuck or 0), handoff_total),       # target <5%
        "engine_degraded_transition_rate": _rate(int(row.degraded or 0), total),  # target <1%
        "duplicate_pending_gate_count": int(dup),                              # target 0
        "blocked_transition_count": int(row.blocked or 0),
        "grandfathered_count": int(row.grandfathered or 0),
        "advisory_observe_count": int(row.advisory or 0),                      # shadow/advisory 관측량
        # ② baseline(enable 전)
        "handoff_total": handoff_total,
        "handoff_acked_count": int(row.acked or 0),
        "dispatch_unresolved_assignee_rate": _rate(int(row.unresolved or 0), handoff_total),
        # step_run_events
        "reminder_count": ev.get("reminded", 0),
        "escalation_count": ev.get("escalated", 0),
        "fallback_notified_count": ev.get("fallback_notified", 0),
    }
