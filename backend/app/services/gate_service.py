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
from app.models.workflow_line import (
    WorkflowLineStepApproval,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
)
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

# doc-gate v2 갭1: deliberate 인간 결재 gate — org allow_auto/deny posture 무관하게 항상 manual(pending).
# disposition auto-pass/auto-deny 제외(인간 deliberation 이 정책 자동결정보다 우선).
# 'loop_decision'(E-LOOP-LEDGER S5): variant 선택도 동일 이유로 항상 human pending — GATE_TYPES에도
# 미등록(doc_approval과 동일 선례. org gate override 설정 대상에서 제외=애초에 자동화 불가 명시).
_ALWAYS_MANUAL_GATE_TYPES: frozenset[str] = frozenset({"doc_approval", "loop_decision"})


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
    # doc-gate v2 갭1(선생님 실 Web): doc_approval 류 deliberate gate 는 disposition auto-pass 무관하게
    # 항상 pending. auto_passed 면 수동 결재가 Gate inbox 에 안 떠 결재 불능(인간 결재 의도 우선).
    if gate_type in _ALWAYS_MANUAL_GATE_TYPES:
        status = "pending"

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
        # E-DG doc-gate(48f064e5): doc 결재 게이트 approve→confirmed·reject→denied.
        await _resolve_doc_gate(session, gate, new_status)

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


async def void_pending_doc_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    voider_id: uuid.UUID,
) -> bool:
    """b13352c2: doc 삭제 cascade — 그 doc 의 pending doc_approval 게이트를 system void(orphan Gate inbox
    항목 방지). 삭제 권한자가 트리거하는 **system cascade**라 human-gate authz(can_approve·human-only) 우회
    정당(별도 결재 아님·actor=삭제자·자기승인 아님·산티아고 검토). 스코핑=`doc_approval` 만(타 gate_type 무접촉)·
    멱등(pending 아니면 no-op)·begin_nested 격리 best-effort(void 실패가 doc 삭제 비중단). 반환=void 수행 여부."""
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
    gate = (await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == doc_id,
            Gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE,
            Gate.gate_type == DOC_GATE_TYPE,
            Gate.status == "pending",
        )
    )).scalar_one_or_none()
    if gate is None:
        return False  # pending doc-gate 없음(terminal/held/부재) → no-op(멱등).
    try:
        async with session.begin_nested():
            await void_gate(
                session, org_id, gate.id, voider_id,
                "doc 삭제 cascade — pending 결재 게이트 자동 무효화",
            )
        return True
    except Exception:
        logger.warning(
            "doc 삭제 cascade void 실패(비중단) doc=%s gate=%s", doc_id, gate.id, exc_info=True
        )
        return False


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


async def _resolve_doc_gate(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """E-DG doc-gate(48f064e5): doc 결재 게이트 해소 → doc status 전이(merge-approve 의 doc 아날로그).

    approve→confirmed · reject→denied. **pending doc 만**(멱등·非pending no-op·이미 결정/취소면 무시).
    human-only 결재(AC4)는 게이트 전이 엔드포인트 authz 에서 강제 — 여기는 status 반영만.
    """
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
    if gate.work_item_type != DOC_GATE_WORK_ITEM_TYPE or gate.gate_type != DOC_GATE_TYPE:
        return
    if new_status not in ("approved", "rejected"):
        return
    from app.models.doc import Doc

    # 방어심층(산티아고): PK get 대신 org_id + soft-delete 가드(타org/삭제 doc 무영향).
    doc = (await session.execute(
        select(Doc).where(
            Doc.id == gate.work_item_id,
            Doc.org_id == gate.org_id,
            Doc.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if doc is None or doc.status != "pending":
        return  # 멱등·pending 아니면 no-op(double-resolve/취소 방어).
    doc.status = "confirmed" if new_status == "approved" else "denied"
    await session.flush()


async def _advance_story_on_merge_approve(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """merge 게이트 approve 시 work_item 스토리를 done으로 진행(H1-FIX-2).

    사람이 이미 approve했으므로 done PATCH의 _preflight 재평가를 우회해 직접 전이한다. reject나
    비-merge 게이트는 진행하지 않는다(reject→in-review 유지). 이미 done이면 no-op(멱등).
    """
    if gate.gate_type != "merge" or gate.work_item_type != "story" or new_status != "approved":
        return
    from app.models.pm import Story  # 순환 회피 lazy import.

    # Bot-L.1: gate-approve 와 PR-merge close-on-merge 가 **단일 idempotent 헬퍼**(advance_story_to_done)를
    # 공유한다 — 상태전이 정책을 1곳에 둬 중복 advance/drift 0. 헬퍼가 done side-effects(events→L1 verdict
    # 증거·webhook·L2·notification·activity)를 발화(board parity). actor=resolver(승인 휴먼·#1504). 이미
    # done/부재면 no-op(멱등).
    from app.services.story_status_events import advance_story_to_done

    story = await session.get(Story, gate.work_item_id)
    await advance_story_to_done(
        session, gate.org_id, story, actor_id=gate.resolver_id, actor_type="human",
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


async def override_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    owner_id: uuid.UUID,
    decision: str,
    reason: str,
) -> Gate:
    """⭐E-DG S33 owner force-resolve: owner(최종권한자)가 막힌/긴급 gate 를 **강제 결정**한다.

    ⚠️void(종료)/hold(정지)/reassign(교체)와 달리 **gate 결정 자체를 강제**(approved|rejected)·정상 결재
    경로(quorum·SoD)를 **우회**한다 → 가장 강력·민감한 액션. 권한=owner-only(라우터 `is_org_owner`·admin
    제외)·reason 필수·owner_id 는 인증 caller 강제(body 신뢰 0·S23 RC①).

    메커니즘: ``transition_gate`` 재사용(FSM pending→approved|rejected·S6 hook 가 라인전이 자동 적용).
    parallel gate 면 남은 pending approver row 를 ``status="overridden"`` 로 닫는다(approved 와 distinct·
    강제 닫힘이지 승인 아님·dangling/SLA 방지). audit(최중) = ``WorkflowLineStepRunEvent(gate_overridden·
    bypassed_sod=True·decision·reason)`` + ``logger.warning`` + 영향받은 requester·bypass된 approver 재-notify
    (자기 gate 가 강제결정된 걸 알아야·안 하면 깜깜).
    """
    if decision not in ("approved", "rejected"):
        raise ValueError("decision 은 approved|rejected 만 가능합니다.")
    if not (reason and reason.strip()):
        raise ValueError("override 는 reason(사유)이 필수입니다.")
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if gate.status != "pending":
        raise ValueError(f"override 는 pending gate 만 가능합니다 (현재 {gate.status}).")

    # 영향받은 pending approver row(parallel) — overridden 마킹 + notify 대상. 단일 gate 면 빈 리스트.
    appr_rows = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.gate_id == gate_id,
            WorkflowLineStepApproval.org_id == org_id,
            WorkflowLineStepApproval.status == "pending",
        )
    )).scalars().all()
    bypassed = [a.approver_member_id for a in appr_rows]
    requester_id = appr_rows[0].requested_by_member_id if appr_rows else None

    # 라인 step_run(audit anchor·project_id) — transition_gate 가 _OPEN 밖으로 보내기 전에 캡처.
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    sr = None
    if sr_id is not None:
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
        )).scalar_one_or_none()

    # ⭐force-resolve: quorum/SoD 우회·S6 hook 라인전이 자동 적용.
    await transition_gate(session, org_id, gate_id, decision, resolver_id=owner_id, note=reason)

    # parallel approver row 닫기(overridden·강제 닫힘이지 승인 아님·dangling/SLA 방지).
    now = datetime.now(timezone.utc)
    for a in appr_rows:
        a.status = "overridden"
        a.resolved_at = now

    # ⭐gate 행에 override 마커(FE cheap 신호·event fetch 없이 "강제 결정됨" 배지). transition_gate 는
    # resolution_note 를 rejected 에만 세팅하므로 approved override 사유가 누락 → neutral_facts 로 보존.
    # 전체 audit/메타(owner·시각·bypassed_sod)는 gate_overridden 이벤트가 SSOT(S32 reassign 동형).
    gate.neutral_facts = {
        **(gate.neutral_facts or {}),
        "overridden": True,
        "override_decision": decision,
        "override_reason": reason,
        "overridden_by_member_id": str(owner_id),
    }

    # audit(최중): bypassed_sod 플래그가 감사 추적 핵심. 라인 step_run 있을 때만 이벤트(없으면 gate행+log).
    if sr is not None:
        session.add(WorkflowLineStepRunEvent(
            org_id=org_id, project_id=sr.project_id, step_run_id=sr.id,
            event_type="gate_overridden", actor_member_id=owner_id,
            payload={
                "decision": decision, "reason": reason, "bypassed_sod": True,
                "bypassed_approver_ids": [str(x) for x in bypassed],
            },
            correlation_id=sr.correlation_id,
        ))
    logger.warning(
        "gate_overridden org=%s gate=%s decision=%s owner=%s bypassed_approvers=%d reason=%s",
        org_id, gate_id, decision, owner_id, len(bypassed), reason,
    )

    # notify requester + bypass된 approver들(Q4·자기 gate 강제결정 통보). best-effort·중복 제거.
    targets: dict[str, uuid.UUID] = {}
    for t in [requester_id, *bypassed]:
        if t is not None:
            targets[str(t)] = t
    if targets:
        try:
            from app.services.notification_dispatch import dispatch_notification
            await dispatch_notification(
                session, org_id=org_id, event_type="gate_overridden",
                target_member_ids=list(targets.values()),
                title="게이트가 강제 결정되었습니다",
                body=f"owner 가 게이트를 {decision} 로 강제 결정했습니다: {reason}",
                reference_type="gate", reference_id=gate_id,
            )
        except Exception:  # noqa: BLE001 — notification 실패는 비중단(override 자체는 성공).
            pass

    await session.flush()
    await session.refresh(gate)
    return gate
