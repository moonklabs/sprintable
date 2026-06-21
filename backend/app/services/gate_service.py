"""E-CAGE-REFEREE P3: HITL Gate 생성·전이·verdict 해소 서비스.

게이트 생성: resolve_disposition() 호출 → disposition에 따라 초기 status 결정.
  allow_auto → auto_passed (숨김, 자동)
  ask        → pending    (인간 개입 필요)
  deny       → rejected   (차단)

상태기계 전이: 불법 전이 거부 (pending→approved|rejected만 허용).

verdict→게이트 해소: P1 verdict 포착이 대응 게이트를 실제로 해소.
  verdict source='pr'|'ci' → gate_type='pr_review'
  verdict source='qa'       → gate_type='qa'
  verdict source='design'   → gate_type='deploy'
  게이트 없으면 graceful skip.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate, is_valid_transition
from app.models.workflow_line import WorkflowLineStepRun
from app.services.gate_resolver import resolve_disposition

logger = logging.getLogger(__name__)

# verdict source → gate_type 매핑
_SOURCE_TO_GATE_TYPE: dict[str, str] = {
    "pr": "pr_review",
    "ci": "pr_review",
    "qa": "qa",
    "design": "deploy",
}

_DISPOSITION_TO_STATUS: dict[str, str] = {
    "allow_auto": "auto_passed",
    "ask": "pending",
    "deny": "rejected",
}


async def create_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    work_item_type: str,
    gate_type: str,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    neutral_facts: dict[str, Any] | None = None,
) -> Gate:
    """config 기반 게이트 생성 (멱등: 이미 있으면 기존 반환)."""
    # 멱등: 이미 존재하면 기존 반환
    existing_r = await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == work_item_id,
            Gate.work_item_type == work_item_type,
            Gate.gate_type == gate_type,
        ).limit(1)
    )
    existing = existing_r.scalar_one_or_none()
    if existing is not None:
        return existing

    disposition = await resolve_disposition(session, org_id, member_id, role_id, gate_type)
    status = _DISPOSITION_TO_STATUS.get(disposition, "pending")

    gate = Gate(
        id=uuid.uuid4(),
        org_id=org_id,
        work_item_id=work_item_id,
        work_item_type=work_item_type,
        gate_type=gate_type,
        status=status,
        neutral_facts=neutral_facts,
        resolved_at=datetime.now(timezone.utc) if status != "pending" else None,
    )
    session.add(gate)
    await session.flush()
    await session.refresh(gate)
    return gate


async def transition_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    new_status: str,
    resolver_id: uuid.UUID | None = None,
    note: str | None = None,
) -> Gate:
    """게이트 상태 전이 — 불법 전이 시 ValueError 발생."""
    gate_r = await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )
    gate = gate_r.scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")

    if not is_valid_transition(gate.status, new_status):
        raise ValueError(
            f"불법 전이: {gate.status} → {new_status}. "
            f"pending에서만 approved|rejected로 전이 가능."
        )

    gate.status = new_status
    gate.resolver_id = resolver_id
    gate.resolved_at = datetime.now(timezone.utc)
    if new_status == "rejected" and note:
        gate.resolution_note = note

    # H1-S7: 사람 게이트 해소(approve/reject)를 verdict로 기록 — trust로 환류.
    await _record_gate_review_verdict(session, org_id, gate, new_status, resolver_id)

    # HO-S7: cold-start(outcome 표본 부족)에서 사람의 keep/kill 결정을 seed로 기록(trust 본점수
    # 미포함·outcome 해소 후 calibration). merge·cold-start가 아니면 no-op.
    from app.services.cold_start_seed import record_cold_start_seed  # 순환 회피 lazy import.

    await record_cold_start_seed(session, org_id, gate, new_status, resolver_id)

    # E-DG S6: gate 전이를 범용 line resolution 에 배선. gate 에 묶인 active line step_run 이 있으면
    # apply_workflow_line_resolution(H1/line approve 동일 status side-effect 경로)·없으면 legacy
    # _advance_story_on_merge_approve 유지(무회귀). 신규 승인경로 0.
    from app.services.workflow_line_resolution import (
        apply_workflow_line_resolution,
        find_active_step_run_for_gate,
    )

    _line_step_run_id = await find_active_step_run_for_gate(session, org_id, gate.id)
    if _line_step_run_id is not None:
        await apply_workflow_line_resolution(session, _line_step_run_id, new_status, resolver_id=resolver_id)
    else:
        # H1-FIX-2: merge 게이트 approve → work item 스토리를 done으로 진행(_preflight 재평가 우회).
        await _advance_story_on_merge_approve(session, gate, new_status)

    await session.flush()
    await session.refresh(gate)
    return gate


async def void_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    voider_id: uuid.UUID,
    reason: str,
) -> Gate:
    """⭐S30 admin recovery: 잘못 생성된 **pending** gate 를 무효화(voided).

    ⚠️void ≠ approval: 묶인 line step_run 을 ``skipped`` 로 해소해 엔티티가 unblock(re-route 가능)되되
    "승인됨"으로 전진하지 않는다(전이 미적용). voider 는 인증 caller(라우터가 강제·body 신뢰 금지·
    S23 RC① 패턴). audit = gate 행(status='voided'·resolver_id·resolution_note)이 distinct 추적
    (approve/reject 와 **status 로 구분**) + app-log. void=복구 액션이라 strict SoD 불요(PO Q4).
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "voided"):
        raise ValueError(f"불법 전이: {gate.status} → voided. pending 게이트만 무효화 가능.")
    if not (reason or "").strip():
        raise ValueError("void 사유(reason)는 필수입니다.")

    gate.status = "voided"
    gate.resolver_id = voider_id
    gate.resolution_note = reason
    gate.resolved_at = datetime.now(timezone.utc)

    # ⭐라인 복구: 묶인 미해소 step_run 을 skipped 로 해소 → 엔티티 unblock(applied 아님=전이 미적용·
    # re-route 가능). find_active_step_run_for_gate 는 _OPEN 상태만 반환·skipped 는 _OPEN 밖이라 닫힘.
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    if sr_id is not None:
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
        )).scalar_one_or_none()
        if sr is not None:
            sr.status = "skipped"
            sr.routing_reason = f"gate voided by admin: {reason}"[:500]
            sr.resolved_at = datetime.now(timezone.utc)

    # void 는 별개 액션으로 app-log 추적(DB distinct 추적은 gate.status='voided'). ⚠️permission_audit_logs
    # 는 action CHECK(member_* 만)라 사용 불가·HitlGateAudit 는 enforce-coverage 전용 → gate 행+log 채택.
    logger.info(
        "gate_voided org=%s gate=%s voider=%s work=%s/%s step_run=%s reason=%s",
        org_id, gate_id, voider_id, gate.work_item_type, gate.work_item_id, sr_id, reason,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def _set_linked_step_run(session, org_id, gate_id, *, status, held_until, reason):
    """gate 에 묶인 미해소 step_run 의 status/held_until 갱신(없으면 no-op·legacy/비-라인 gate)."""
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    if sr_id is None:
        return None
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
    )).scalar_one_or_none()
    if sr is not None:
        sr.status = status
        sr.held_until = held_until
        if reason is not None:
            sr.routing_reason = reason[:500]
    return sr_id


async def hold_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    holder_id: uuid.UUID,
    reason: str | None = None,
    held_until: datetime | None = None,
) -> Gate:
    """⭐S31 admin hold: pending gate 를 일시 보류(held). void(종료)와 달리 **가역**(unhold 재개).

    묶인 step_run.status='held'+held_until 세팅 → SLA processor 가 reminder/escalation 일시정지(pause).
    holder=인증 caller(라우터 강제·body 신뢰 0·S23 RC①). audit=gate 행(status='held'·resolver_id=holder·
    resolution_note=reason·held_until)이 현 상태(status='held' 가 disambiguate·unhold 시 clear)+app-log
    `gate_held`(durable 이력·S30 void 패턴). 사유는 선택(가역적 일시정지라 마찰↓).
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "held"):
        raise ValueError(f"불법 전이: {gate.status} → held. pending 게이트만 보류 가능.")

    gate.status = "held"
    gate.resolver_id = holder_id          # status='held' 가 holder 로 해석(approve/reject 아님)
    gate.resolution_note = reason          # 선택
    gate.held_until = held_until           # 무기한이면 None
    sr_id = await _set_linked_step_run(
        session, org_id, gate_id, status="held", held_until=held_until,
        reason=f"gate held by admin{(': ' + reason) if reason else ''}",
    )
    logger.info(
        "gate_held org=%s gate=%s holder=%s work=%s/%s step_run=%s until=%s reason=%s",
        org_id, gate_id, holder_id, gate.work_item_type, gate.work_item_id, sr_id, held_until, reason,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def unhold_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    actor_id: uuid.UUID,
) -> Gate:
    """⭐S31 admin unhold: held gate 를 재개(→pending). SLA 재개(step_run→gate_pending·다음 스캔서 처리).

    held 상태 audit 필드(resolver_id/resolution_note/held_until)를 **clear**(재개된 pending 깨끗)·이력은
    app-log `gate_unheld`. holder/actor=인증 caller(라우터 강제).
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "pending"):
        raise ValueError(f"불법 전이: {gate.status} → pending. 보류(held) 게이트만 재개 가능.")

    gate.status = "pending"
    gate.resolver_id = None
    gate.resolution_note = None
    gate.held_until = None
    sr_id = await _set_linked_step_run(
        session, org_id, gate_id, status="gate_pending", held_until=None,
        reason="gate unheld by admin (resumed)",
    )
    logger.info(
        "gate_unheld org=%s gate=%s actor=%s work=%s/%s step_run=%s",
        org_id, gate_id, actor_id, gate.work_item_type, gate.work_item_id, sr_id,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def _advance_story_on_merge_approve(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """merge 게이트 approve 시 work_item 스토리를 done으로 진행(H1-FIX-2).

    사람이 이미 approve했으므로 done PATCH의 _preflight 재평가를 우회해 직접 전이한다. reject나
    비-merge 게이트는 진행하지 않는다(reject→in-review 유지). 이미 done이면 no-op(멱등).
    """
    if gate.gate_type != "merge" or gate.work_item_type != "story" or new_status != "approved":
        return
    from app.models.pm import Story  # 순환 회피 lazy import.

    story = await session.get(Story, gate.work_item_id)
    if story is not None and story.status != "done":
        old_status = story.status
        story.status = "done"
        await session.flush()
        # 41a6e294: gate-driven done도 정상 status-change side-effects를 발화 — events(→L1
        # activity_events 캡처=verdict 증거원)·webhook·L2 trigger·notification·activity. status만
        # 직접 set하면 활동그래프 누락(게이트가 만든 done이 게이트 증거에 안 잡히는 자기모순).
        # actor=resolver(승인 휴먼·#1504로 휴먼 보장). 정상 board 경로와 공유 helper(parity).
        from app.services.story_status_events import emit_story_status_changed

        await emit_story_status_changed(
            session, gate.org_id, story, old_status,
            actor_id=gate.resolver_id, actor_type="human",
        )


# gate_type → verdict source (qa→qa·merge→merge·deploy→design·pr_review→pr).
_GATE_TYPE_TO_VERDICT_SOURCE: dict[str, str] = {
    "qa": "qa",
    "deploy": "design",
    "merge": "merge",
    "pr_review": "pr",
}
# 이 시간(초) 이하 approve는 rubber stamp(고무도장) 후보로 관측 표시.
_RUBBER_STAMP_SECONDS = 30


async def _record_gate_review_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate: Gate,
    new_status: str,
    resolver_id: uuid.UUID | None,
) -> None:
    """사람 게이트 해소를 verdict로 환류(H1-S7).

    approve→result=pass / reject→result=fail. resolver_id 없으면 skip(AC③·시스템 auto-transition은
    resolver 없으니 자동 제외 = 루프 가드 겸용). verdict는 work item의 implementation participation에
    gate_type-매핑 source로 기록(uq(participation,source) upsert 멱등). 30초 이하 approve는
    neutral_facts.rubber_stamp_candidate=true로 관측(AC⑤).
    """
    if new_status not in ("approved", "rejected") or resolver_id is None:
        return
    source = _GATE_TYPE_TO_VERDICT_SOURCE.get(gate.gate_type)
    if source is None or gate.work_item_type != "story":
        return

    # lazy import — verdict_capture/recorder가 gate_service를 import하므로 순환 회피.
    from app.services.verdict_capture import resolve_implementation_participation
    from app.services.verdict_recorder import record_verdict

    participation = await resolve_implementation_participation(session, org_id, gate.work_item_id)
    if participation is None:
        return  # participation 없으면 거짓기록 금지(skip).

    result = "pass" if new_status == "approved" else "fail"  # AC①②
    await record_verdict(session, org_id, participation.id, source, result)

    # AC⑤: 30초 이하 approve = rubber stamp 후보 관측(neutral_facts 추가·판정 아님).
    if (
        new_status == "approved"
        and gate.created_at is not None
        and gate.resolved_at is not None
        and (gate.resolved_at - gate.created_at).total_seconds() <= _RUBBER_STAMP_SECONDS
    ):
        facts = dict(gate.neutral_facts or {})
        facts["rubber_stamp_candidate"] = True
        gate.neutral_facts = facts


async def resolve_gate_from_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    work_item_type: str,
    verdict_source: str,
    verdict_result: str | None,
    resolver_id: uuid.UUID | None = None,
) -> Gate | None:
    """verdict 포착 결과를 대응 게이트 해소로 연결.

    verdict source → gate_type 매핑 후 pending 게이트 탐색.
    없으면 graceful skip (None 반환).
    result=None → pending 유지 (미측정 거짓해소 금지).
    """
    gate_type = _SOURCE_TO_GATE_TYPE.get(verdict_source)
    if gate_type is None:
        return None

    if verdict_result is None:
        return None  # 미측정 → 강제 해소 금지

    gate_r = await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == work_item_id,
            Gate.work_item_type == work_item_type,
            Gate.gate_type == gate_type,
            Gate.status == "pending",
        ).limit(1)
    )
    gate = gate_r.scalar_one_or_none()
    if gate is None:
        return None  # 게이트 없음 → graceful

    new_status = "approved" if verdict_result == "pass" else "rejected"
    gate.status = new_status
    gate.resolver_id = resolver_id
    gate.resolved_at = datetime.now(timezone.utc)
    await session.flush()
    await session.refresh(gate)
    return gate
