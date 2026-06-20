"""E-DECISION-GATE S17: recall/withdraw pending gate action.

author/owner 가 승인 前 pending gate run 을 철회한다(reject 안 거치고). Gate enum 확장 없이(Phase1)
``workflow_line_step_runs.status='withdrawn'`` + approval rows ``withdrawn`` 으로 표현한다.

- ② ⭐기존 ``Gate`` enum 미확장 — withdraw 는 run/approval status 로만. ③ entity status 미전이
  (from_status 유지). ④ requester/owner/admin 만(SoD). ⑤ idempotent(terminal 시도→not_active·FOR
  UPDATE 직렬화). ⑥ withdrawn step_run_event 기록.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.team import TeamMember
from app.models.workflow_line import (
    WorkflowLineStepApproval,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
)

# withdraw 가능한 active pending 상태(AC①).
_ACTIVE_PENDING = ("waiting_gate", "waiting_parallel", "gate_pending")
_PRIVILEGED_ROLES = frozenset({"admin", "owner", "product_owner"})


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _is_requester(session: AsyncSession, sr: WorkflowLineStepRun, actor_id: uuid.UUID) -> bool:
    """run 의 author(requested_by) 인가 — approval rows 의 requested_by_member_id 로 해소."""
    if sr.approval_group_id is None:
        return False
    rb = (await session.execute(
        select(WorkflowLineStepApproval.requested_by_member_id).where(
            WorkflowLineStepApproval.approval_group_id == sr.approval_group_id,
            WorkflowLineStepApproval.requested_by_member_id.is_not(None),
        ).limit(1)
    )).scalar_one_or_none()
    return rb is not None and str(rb) == str(actor_id)


async def _is_privileged(session: AsyncSession, org_id: uuid.UUID, actor_id: uuid.UUID) -> bool:
    m = await session.get(TeamMember, actor_id)
    return m is not None and m.org_id == org_id and (m.role in _PRIVILEGED_ROLES)


async def withdraw_pending_run(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID, step_run_id: uuid.UUID,
    actor_id: uuid.UUID, reason: str | None = None,
) -> dict:
    """pending run 철회. 반환 status: withdrawn|not_found|not_active|forbidden."""
    # ⑤ FOR UPDATE 로 직렬화(동시 withdraw·fresh status).
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.id == step_run_id,
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.entity_type == "story",
            WorkflowLineStepRun.entity_id == story_id,
        ).with_for_update()
    )).scalar_one_or_none()
    if sr is None:
        return {"status": "not_found"}
    # ⑤ idempotent: active pending 아니면 no-op(terminal/withdrawn 재시도).
    if sr.status not in _ACTIVE_PENDING:
        return {"status": "not_active", "run_status": sr.status}
    # ④ authz: requester(author) 또는 owner/admin.
    if not (await _is_requester(session, sr, actor_id)
            or await _is_privileged(session, org_id, actor_id)):
        return {"status": "forbidden"}

    sr.status = "withdrawn"  # ② run status 로만(Gate enum 미확장)·③ entity 미전이(from_status 유지)
    sr.withdrawn_by_member_id = actor_id
    sr.withdrawn_at = _now()
    sr.withdraw_reason = reason
    # gate 해소(③): pending approval rows 를 withdrawn 으로 닫음(approval enum 내·Gate enum 불변).
    if sr.approval_group_id is not None:
        await session.execute(
            update(WorkflowLineStepApproval).where(
                WorkflowLineStepApproval.approval_group_id == sr.approval_group_id,
                WorkflowLineStepApproval.status == "pending",
            ).values(status="withdrawn", resolved_at=_now())
        )
    # ⭐B1(까심): Gate instance 도 닫는다. 안 닫으면 다른 approver 가 POST /gates/{id}/transition→approved
    # 시 find_active_step_run_for_gate 가 withdrawn run 을 못 찾아 legacy _advance_story_on_merge_approve
    # 로 story=done 우회. Gate enum 미확장 유지 — 기존 'rejected'(withdraw 시맨틱)로 pending gate 닫음.
    gate_ids = [g for g in (sr.gate_id, sr.h1_gate_id) if g is not None]
    if gate_ids:
        await session.execute(
            update(Gate).where(
                Gate.id.in_(gate_ids), Gate.org_id == org_id, Gate.status == "pending",
            ).values(status="rejected", resolver_id=actor_id, resolved_at=_now(),
                     resolution_note="withdrawn by author")
        )
    # ⑥ withdrawn event.
    session.add(WorkflowLineStepRunEvent(
        org_id=org_id, project_id=sr.project_id, step_run_id=step_run_id, event_type="withdrawn",
        actor_member_id=actor_id, payload={"reason": reason} if reason else {},
        correlation_id=sr.correlation_id,
    ))
    await session.flush()
    await session.commit()
    return {"status": "withdrawn", "step_run_id": str(step_run_id)}
