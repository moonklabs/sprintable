"""E-DECISION-GATE S9: parallel/quorum approval MVP.

multi-approver gate 를 **대표 Gate 1개 + workflow_step_approvals approver row N개**로 표면화한다
(Gate 단일 row UX 유지·AC①). blocking approver-kind row 만 quorum 에 들고(consult/non-blocking 은
audit/notification 엔 남지만 제외·AC④), quorum 충족/any-reject 면 ``transition_gate()`` 단일 rail 로
해소한다(S6 hook ``find_active_step_run_for_gate`` 가 라인 전이를 자동 적용·신규 승인경로 0·AC⑤).

⭐SoD self-approval guard 는 **row 생성 시 + 해소 시 동시 검사**(AC⑥): approver/resolver 가
requested_by / implementation / original_approver 와 동일하면 거부.
"""
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
)

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
