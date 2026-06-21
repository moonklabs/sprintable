"""E-DECISION-GATE S9: parallel/quorum approval MVP.

multi-approver gate 를 **대표 Gate 1개 + workflow_step_approvals approver row N개**로 표면화한다
(Gate 단일 row UX 유지·AC①). blocking approver-kind row 만 quorum 에 들고(consult/non-blocking 은
audit/notification 엔 남지만 제외·AC④), quorum 충족/any-reject 면 ``transition_gate()`` 단일 rail 로
해소한다(S6 hook ``find_active_step_run_for_gate`` 가 라인 전이를 자동 적용·신규 승인경로 0·AC⑤).

⭐SoD self-approval guard 는 **row 생성 시 + 해소 시 동시 검사**(AC⑥): approver/resolver 가
requested_by / implementation / original_approver 와 동일하면 거부.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.workflow_line import (
    QUORUM_TYPES,
    WorkflowLineStepApproval,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
)

logger = logging.getLogger(__name__)

_TERMINAL_GATE = frozenset({"approved", "rejected"})
_VALID_DECISIONS = frozenset({"approved", "rejected", "abstained"})


class SelfApprovalError(Exception):
    """SoD: approver/resolver 가 requested_by/implementation/original_approver 와 동일(self-approval forbidden)."""

    def __init__(self, member_id: uuid.UUID | None):
        self.member_id = member_id
        super().__init__(f"self-approval forbidden (SoD): member {member_id}")


def _sod_conflict(member_id: uuid.UUID | None, *sod_parties: uuid.UUID | None) -> bool:
    if member_id is None:
        return False
    mid = str(member_id)
    return any(p is not None and str(p) == mid for p in sod_parties)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def create_parallel_gate(
    session: AsyncSession, step_run: WorkflowLineStepRun, *,
    approvers: list[dict[str, Any]], quorum: dict[str, Any],
    member_id: uuid.UUID, role_id: uuid.UUID, gate_type: str = "merge",
    requested_by_member_id: uuid.UUID | None = None,
    implementation_member_id: uuid.UUID | None = None,
) -> tuple[Gate, uuid.UUID]:
    """대표 Gate 1개 + approver row N개를 만든다. step_run.gate_id 로 S6 hook 에 연결(orphan 0·AC⑦).

    quorum: {type: all|any|count, count?: int, reject_policy?: any_reject_blocks}.
    approvers[i]: {member_id, member_type?, kind?(approver|consult|deputy), blocking?, role_key?,
    original_approver_member_id?}.
    """
    qtype = (quorum or {}).get("type", "all")
    if qtype not in QUORUM_TYPES:
        raise ValueError(f"unsupported quorum type: {qtype} (percent=Phase3 defer)")

    from app.services.gate_service import create_gate
    gate = await create_gate(
        session, step_run.org_id, step_run.entity_id, step_run.entity_type, gate_type,
        member_id, role_id,
        neutral_facts={
            "requested_by_member_id": str(requested_by_member_id) if requested_by_member_id else None,
            "parallel": True,
        },
    )
    group_id = uuid.uuid4()
    step_run.gate_id = gate.id  # ⭐S6 hook 연결: transition_gate→find_active_step_run_for_gate→라인 전이
    step_run.approval_group_id = group_id
    step_run.quorum_policy = {
        "type": qtype, "count": quorum.get("count"),
        "reject_policy": quorum.get("reject_policy", "any_reject_blocks"),
    }

    for a in approvers:
        kind = a.get("kind", "approver")
        blocking = a.get("blocking", kind == "approver")
        aid = a["member_id"]
        # ⭐SoD(생성 시): blocking approver 는 SoD 당사자와 동일 불가(consult/non-blocking 은 정보용 허용).
        if kind == "approver" and blocking and _sod_conflict(
            aid, requested_by_member_id, implementation_member_id, a.get("original_approver_member_id"),
        ):
            raise SelfApprovalError(aid)
        session.add(WorkflowLineStepApproval(
            org_id=step_run.org_id, project_id=step_run.project_id, step_run_id=step_run.id,
            gate_id=gate.id, approval_group_id=group_id,
            approver_member_id=aid, approver_member_type=a.get("member_type", "human"),
            original_approver_member_id=a.get("original_approver_member_id"),
            requested_by_member_id=requested_by_member_id,
            implementation_member_id=implementation_member_id,
            role_key=a.get("role_key"), kind=kind, blocking=blocking, status="pending",
        ))
    await session.flush()
    return gate, group_id


async def _tally_blocking(session: AsyncSession, group_id: uuid.UUID) -> dict[str, int]:
    """그룹의 blocking approver-kind row 집계(consult/non-blocking 제외·AC④)."""
    rows = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.approval_group_id == group_id,
            WorkflowLineStepApproval.kind == "approver",
            WorkflowLineStepApproval.blocking.is_(True),
        )
    )).scalars().all()
    return {
        "approved": sum(1 for r in rows if r.status == "approved"),
        "rejected": sum(1 for r in rows if r.status == "rejected"),
        "total_blocking": len(rows),
    }


def _quorum_met(approved: int, total_blocking: int, qtype: str, qcount: int | None) -> bool:
    if total_blocking == 0:
        return False
    if qtype == "all":
        return approved >= total_blocking
    if qtype == "any":
        return approved >= 1
    if qtype == "count":
        return qcount is not None and approved >= qcount
    return False


async def record_parallel_decision(
    session: AsyncSession, approval_id: uuid.UUID, decision: str, resolver_id: uuid.UUID | None,
) -> dict[str, Any]:
    """approver row 1건 결정을 기록하고 그룹 quorum 을 재평가한다.

    blocking approver-kind row 만 집계(consult/non-blocking 제외). any reject(any_reject_blocks)→
    ``transition_gate(rejected)`` / quorum 충족→``transition_gate(approved)`` / else pending.
    gate 가 이미 terminal 이면 멱등 skip(중복 해소 무시).
    """
    if decision not in _VALID_DECISIONS:
        raise ValueError(f"invalid decision: {decision}")
    appr = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.id == approval_id
        ).with_for_update()
    )).scalar_one_or_none()
    if appr is None:
        raise ValueError(f"approval {approval_id} not found")

    # resolver 는 본인 row 만 해소(대리 위임은 후속 Phase).
    if resolver_id is not None and str(resolver_id) != str(appr.approver_member_id):
        raise SelfApprovalError(resolver_id)
    # ⭐SoD(해소 시·AC⑥ 2중): resolver 가 SoD 당사자면 거부.
    if _sod_conflict(
        resolver_id, appr.requested_by_member_id, appr.implementation_member_id,
        appr.original_approver_member_id,
    ):
        raise SelfApprovalError(resolver_id)

    # ⭐terminal 멱등 skip: gate 가 이미 해소(approved/rejected)됐으면 late decision 은 approval row
    # 를 mutate 하지 않고 그대로 skip 한다(quorum 충족/any-reject 로 게이트가 닫힌 뒤 도착한 결정이
    # row state·audit 를 오염시키지 않게·SME 적출). row mutate 보다 먼저 검사한다.
    gate = None
    if appr.gate_id is not None:
        gate = (await session.execute(
            select(Gate).where(Gate.id == appr.gate_id, Gate.org_id == appr.org_id)
        )).scalar_one_or_none()
        if gate is not None and gate.status in _TERMINAL_GATE:
            tally = await _tally_blocking(session, appr.approval_group_id)
            return {"outcome": gate.status, "skipped": True, **tally}

    appr.status = decision
    appr.resolved_at = _now()
    await session.flush()

    # 그룹의 blocking approver-kind row 로 quorum 재계산(consult/non-blocking 제외·AC④).
    tally = await _tally_blocking(session, appr.approval_group_id)
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == appr.step_run_id)
    )).scalar_one_or_none()
    policy = ((sr.quorum_policy if sr else None) or {})
    qtype = policy.get("type", "all")
    qcount = policy.get("count")
    reject_policy = policy.get("reject_policy", "any_reject_blocks")

    outcome = "pending"
    target: str | None = None
    if reject_policy == "any_reject_blocks" and tally["rejected"] >= 1:
        target = "rejected"
    elif _quorum_met(tally["approved"], tally["total_blocking"], qtype, qcount):
        target = "approved"

    # target 도달 시 transition_gate 단일 rail 로 해소(gate 는 위에서 non-terminal 확인됨).
    if target is not None and gate is not None:
        from app.services.gate_service import transition_gate
        await transition_gate(session, appr.org_id, appr.gate_id, target, resolver_id=resolver_id)
        outcome = target

    return {"outcome": outcome, "skipped": False, **tally}


async def list_gate_approvers(
    session: AsyncSession, org_id: uuid.UUID, gate_id: uuid.UUID
) -> list[WorkflowLineStepApproval]:
    """⭐S32 FE conditional-display: gate 의 approver row 목록(있으면 parallel gate → reassign 노출).
    단일/merge gate 는 빈 리스트(approver row 없음 → FE reassign 미노출·422 원천차단)."""
    r = await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.gate_id == gate_id,
            WorkflowLineStepApproval.org_id == org_id,
        ).order_by(WorkflowLineStepApproval.created_at.asc())
    )
    return list(r.scalars().all())


async def reassign_approver(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    new_approver_id: uuid.UUID,
    reassigner_id: uuid.UUID,
    old_approver_id: uuid.UUID | None = None,
    reason: str | None = None,
) -> WorkflowLineStepApproval:
    """⭐S32: parallel gate 의 pending blocking approver 를 다른 멤버로 재지정(부재·오배정·휴가 복구).

    void(종료)/hold(일시정지)와 달리 **gate.status 안 바꿈**(pending 유지·재결정 대상). approver row 의
    approver_member_id 만 교체. scaffold 컬럼(reassigned_from_member_id·original_approver_member_id) 활용
    → 마이그0. 단일/merge gate(approver row 없음)는 422("명시적 결재자 없음"·parallel 전용·Q1). 새 approver
    유효성=org 멤버 실재+project_auth 접근권. reassigner=인증 caller(라우터 강제). audit=step_run_event
    (approver_reassigned)+app-log. 새 approver 재-notify(dispatch·안 하면 gate stall).
    """
    rows = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.gate_id == gate_id,
            WorkflowLineStepApproval.org_id == org_id,
            WorkflowLineStepApproval.status == "pending",
            WorkflowLineStepApproval.blocking.is_(True),
            WorkflowLineStepApproval.kind == "approver",
        )
    )).scalars().all()
    if not rows:
        raise ValueError("이 게이트엔 재지정할 명시적 결재자(approver)가 없습니다 (parallel gate 전용).")
    if old_approver_id is not None:
        target = next((a for a in rows if a.approver_member_id == old_approver_id), None)
        if target is None:
            raise ValueError("old_approver_id 에 해당하는 pending 결재자가 없습니다.")
    elif len(rows) == 1:
        target = rows[0]
    else:
        raise ValueError("결재자가 여러 명입니다 — old_approver_id 를 지정하세요.")

    if new_approver_id == target.approver_member_id:
        raise ValueError("이미 그 멤버가 결재자입니다.")
    # 새 approver 유효성: org 멤버 실재 + 프로젝트 접근권(IDOR/유령 결재자 방지·Q5).
    from app.services.member_resolver import resolve_member_identity
    member = await resolve_member_identity(new_approver_id, org_id, session)
    if member is None:
        raise ValueError("새 결재자가 이 org 의 멤버가 아닙니다.")
    from app.services.project_auth import has_project_access
    if not await has_project_access(session, new_approver_id, target.project_id, org_id):
        raise ValueError("새 결재자가 해당 프로젝트 접근권이 없습니다.")
    # ⭐SoD(AC⑥ 동형): 새 결재자가 요청자/구현자/최초결재자와 동일하면 거부(reassign 으로 자기승인 우회
    # 금지). record_parallel_decision 의 해소-시 SoD 와 동일 가드를 지정-시에도 선제 적용.
    if _sod_conflict(
        new_approver_id, target.requested_by_member_id, target.implementation_member_id,
        target.original_approver_member_id,
    ):
        raise ValueError("새 결재자가 SoD 당사자(요청자/구현자/최초결재자)와 동일 — 자기승인 우회 금지.")

    old_id = target.approver_member_id
    target.reassigned_from_member_id = old_id
    if target.original_approver_member_id is None:
        target.original_approver_member_id = old_id  # 최초 결재자만 보존(체인 누적 아님)
    target.approver_member_id = new_approver_id
    target.approver_member_type = member.type
    # status 는 pending 유지(재결정 대상·gate status 도 불변).

    session.add(WorkflowLineStepRunEvent(
        org_id=org_id, project_id=target.project_id, step_run_id=target.step_run_id,
        event_type="approver_reassigned", actor_member_id=reassigner_id,
        target_member_id=new_approver_id,
        payload={"old_approver_id": str(old_id), "gate_id": str(gate_id), "reason": reason},
        correlation_id=uuid.uuid4(),
    ))
    logger.info(
        "approver_reassigned org=%s gate=%s old=%s new=%s by=%s reason=%s",
        org_id, gate_id, old_id, new_approver_id, reassigner_id, reason,
    )
    # 새 approver 재-notify(안 하면 새 결재자 모르고 gate stall·Q5). best-effort.
    try:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=org_id, event_type="gate_reassigned",
            target_member_ids=[new_approver_id], title="결재자로 재지정됨",
            body="관리자가 당신을 이 결재의 새 결재자로 지정했습니다.",
            reference_type="gate", reference_id=gate_id,
        )
    except Exception:  # noqa: BLE001 — notification 실패는 비중단(재지정 자체는 성공).
        pass
    await session.flush()
    return target
