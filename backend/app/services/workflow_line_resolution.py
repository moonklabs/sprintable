"""E-DECISION-GATE S6: gate 전이 → 범용 line resolution 배선.

gate 승인/반려가 ``transition_gate()`` 를 타면, 그 gate 에 묶인 active line step_run 을 찾아 line
정책대로 status 를 적용한다. H1 approve 와 line approve 가 **동일 status side-effect 경로**
(``emit_story_status_changed``)를 타도록 통일한다(신규 승인경로 0). line run 이 없으면 호출부가
legacy ``_advance_story_on_merge_approve`` 로 폴백한다(무회귀).

P1-1 idempotency: story/run 을 row lock(SELECT FOR UPDATE)하고, stale ``from_status``(story 가 이미
다른 status 로 이동)면 적용하지 않는다. 이미 목표 status 면 no-op.
"""
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import (
    WorkflowLineDefinitionVersion,
    WorkflowLineStepRun,
)
from app.services.workflow_readiness_matrix import get_readiness, record_unsupported_entity_attempt

logger = logging.getLogger(__name__)

# 이 gate 에 묶인 step_run 이 아직 미해소(승인/반려 대기) 상태로 볼 수 있는 집합.
_OPEN_STEP_RUN_STATUSES = frozenset({
    "pending", "routing_resolved", "dispatched", "waiting_gate", "waiting_parallel",
    "gate_pending", "reminded", "escalated", "held",
})


async def find_active_step_run_for_gate(
    session: AsyncSession, org_id: uuid.UUID, gate_id: uuid.UUID
) -> uuid.UUID | None:
    """gate_id(또는 h1_gate_id)에 묶인 미해소 line step_run id. 없으면 None(→legacy 폴백)."""
    r = await session.execute(
        select(WorkflowLineStepRun.id).where(
            WorkflowLineStepRun.org_id == org_id,
            (WorkflowLineStepRun.gate_id == gate_id) | (WorkflowLineStepRun.h1_gate_id == gate_id),
            WorkflowLineStepRun.status.in_(_OPEN_STEP_RUN_STATUSES),
        ).order_by(WorkflowLineStepRun.started_at.desc()).limit(1)
    )
    return r.scalar_one_or_none()


async def _step_config(session: AsyncSession, step_run: WorkflowLineStepRun) -> dict[str, Any]:
    """step_run 이 가리키는 published config 의 매칭 step(on_approve/on_reject 등)."""
    if step_run.line_definition_id is None:
        return {}
    r = await session.execute(
        select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.line_definition_id == step_run.line_definition_id,
            WorkflowLineDefinitionVersion.status == "published",
        ).order_by(WorkflowLineDefinitionVersion.version.desc()).limit(1)
    )
    version = r.scalar_one_or_none()
    config = dict(version.config) if version and isinstance(version.config, dict) else {}
    for step in config.get("steps") or []:
        if (isinstance(step, dict) and step.get("to_status") == step_run.to_status
                and step.get("from_status") in (step_run.from_status, None)):
            return step
    return {}


async def _apply_hypothesis_active(
    session: AsyncSession, sr: WorkflowLineStepRun, resolver_id: uuid.UUID | None
) -> None:
    """S23: hypothesis proposed→active gate 승인 적용. native ``transition_hypothesis`` 재사용
    (parallel FSM 0·AC3 동일결과+confirmed_by). ⭐SoD(AC5·trust-gaming): approver ≠ owner_member_id."""
    from app.models.hypothesis import Hypothesis
    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis
    from app.services.member_resolver import ResolvedMember

    hyp = (await session.execute(
        select(Hypothesis).where(Hypothesis.id == sr.entity_id).with_for_update()
    )).scalar_one_or_none()
    if hyp is None:
        sr.status = "approved"
        sr.resolved_at = _now()
        await session.flush()
        return
    if hyp.status == "active":  # 멱등: 다른 경로로 이미 active → no-op.
        sr.status = "applied"
        sr.resolved_at = _now()
        await session.flush()
        return
    if hyp.status != "proposed":  # stale: proposed 아니면 미적용(killed/archived 등).
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        return
    # ⭐SoD: approver 미상이거나 owner 자신이면 차단(자기 hyp 자기 confirm = trust-gaming).
    if resolver_id is None or resolver_id == hyp.owner_member_id:
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        logger.warning(
            "hypothesis_activation_sod_block sr=%s approver=%s owner=%s",
            sr.id, resolver_id, hyp.owner_member_id,
        )
        return
    # 적용: native 전이 재사용(via_gate=True → overlay re-gate 루프 차단). confirmed_by=approver.
    approver = ResolvedMember(
        id=resolver_id, user_id=None, name="gate_approver", type="human", role="member",
        org_id=sr.org_id,
    )
    await transition_hypothesis(
        session, sr.org_id, approver, hyp.id, HypothesisTransition(status="active"), via_gate=True,
    )
    sr.status = "applied"
    sr.resolved_at = _now()
    await session.flush()


async def _apply_doc_confirmed(
    session: AsyncSession, sr: WorkflowLineStepRun, resolver_id: uuid.UUID | None
) -> None:
    """S22: doc draft→confirmed gate 승인 적용. native ``transition_doc`` 재사용(parallel 0). ⭐SoD:
    approver ≠ doc.created_by(author·자기 doc 자기 confirm 차단). 승인 후 author(created_by) 자동재개
    wake(commit=False·gate 트랜잭션 합류·§6 dispatch tx commit 0)."""
    from app.models.doc import Doc
    from app.services.doc import transition_doc
    from app.services.member_resolver import ResolvedMember

    doc = (await session.execute(
        select(Doc).where(Doc.id == sr.entity_id).with_for_update()
    )).scalar_one_or_none()
    if doc is None:
        sr.status = "approved"
        sr.resolved_at = _now()
        await session.flush()
        return
    if doc.status == "confirmed":  # 멱등: 이미 confirmed → no-op.
        sr.status = "applied"
        sr.resolved_at = _now()
        await session.flush()
        return
    if doc.status != "draft":  # stale: draft 아니면 미적용.
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        return
    # ⭐SoD(RC②): approver 미상 OR author 불명(created_by None) OR author 자신이면 차단. ⚠️created_by
    # None 을 fail-closed 로 막지 않으면 created_by=null doc 생성 후 self-confirm 으로 SoD 우회([[feedback_actor_type_failclosed]]).
    if resolver_id is None or doc.created_by is None or resolver_id == doc.created_by:
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        logger.warning(
            "doc_confirm_sod_block sr=%s approver=%s author=%s", sr.id, resolver_id, doc.created_by,
        )
        return
    approver = ResolvedMember(
        id=resolver_id, user_id=None, name="gate_approver", type="human", role="member",
        org_id=sr.org_id,
    )
    await transition_doc(session, sr.org_id, approver, doc.id, "confirmed", via_gate=True)
    # author 자동재개(success_hypothesis): created_by 에게 dispatched 이벤트(commit=False → gate
    # 트랜잭션 합류·gates.py:137 commit 후 agent 가 consume·새 event type 0·trigger_metadata만).
    if doc.created_by is not None:
        from app.services.agent_dispatch import dispatch_payload_to_member
        await dispatch_payload_to_member(
            session, sr.org_id, doc.created_by,
            title=doc.title or "doc", content=f"[doc confirmed] {doc.title or ''}".strip(),
            source_entity_type="doc", source_entity_id=doc.id, project_id=doc.project_id,
            trigger_metadata={"source": "workflow_line", "reason": "doc_confirmed"}, commit=False,
        )
    sr.status = "applied"
    sr.resolved_at = _now()
    await session.flush()


async def _apply_epic_transition(
    session: AsyncSession, sr: WorkflowLineStepRun, resolver_id: uuid.UUID | None
) -> None:
    """S25: epic draft→active / active→done gate 승인 적용. native ``transition_epic``(via_gate) 재사용
    (parallel 0). ⭐SoD(draft→active activation 만): approver ≠ epic.assignee_id(owner proxy·fail-closed).
    ⚠️epic assignee 흔히 null→enforcing 시 과차단 — enforcing 전 SoD 대상 project owner 로 정교화 필요
    (enable-prep·default-off 무해). active→done(completion)은 SoD 무관."""
    from app.models.pm import Epic
    from app.services.epic import transition_epic
    from app.services.member_resolver import ResolvedMember

    epic = (await session.execute(
        select(Epic).where(Epic.id == sr.entity_id).with_for_update()
    )).scalar_one_or_none()
    if epic is None:
        sr.status = "approved"
        sr.resolved_at = _now()
        await session.flush()
        return
    if epic.status == sr.to_status:  # 멱등
        sr.status = "applied"
        sr.resolved_at = _now()
        await session.flush()
        return
    if sr.from_status is not None and epic.status != sr.from_status:  # stale
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        return
    # ⭐SoD: activation(draft→active)만·approver 미상 ∨ assignee 불명 ∨ ==assignee → 차단(fail-closed).
    if sr.to_status == "active" and (
        resolver_id is None or epic.assignee_id is None or resolver_id == epic.assignee_id
    ):
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        logger.warning(
            "epic_activation_sod_block sr=%s approver=%s assignee=%s",
            sr.id, resolver_id, epic.assignee_id,
        )
        return
    approver = ResolvedMember(
        id=resolver_id, user_id=None, name="gate_approver", type="human", role="member",
        org_id=sr.org_id,
    )
    await transition_epic(session, sr.org_id, approver, epic.id, sr.to_status, via_gate=True)
    # assignee 자동재개: epic assignee 에게 dispatched(commit=False·gate 트랜잭션 합류·§6 tx commit 0).
    if epic.assignee_id is not None:
        from app.services.agent_dispatch import dispatch_payload_to_member
        await dispatch_payload_to_member(
            session, sr.org_id, epic.assignee_id,
            title=epic.title or "epic", content=f"[epic {sr.to_status}] {epic.title or ''}".strip(),
            source_entity_type="epic", source_entity_id=epic.id, project_id=epic.project_id,
            trigger_metadata={"source": "workflow_line", "reason": f"epic_{sr.to_status}"}, commit=False,
        )
    sr.status = "applied"
    sr.resolved_at = _now()
    await session.flush()


async def apply_workflow_line_resolution(
    session: AsyncSession, step_run_id: uuid.UUID, new_status: str,
    resolver_id: uuid.UUID | None = None,
) -> None:
    """gate 해소(approved|rejected)를 line step_run 정책대로 적용.

    approve + ``on_approve.apply_transition=true`` → story 를 step_run.to_status 로 전이(H1 과 동일
    ``emit_story_status_changed`` 경로). reject → Phase1 기본 in-review 유지(status set/relay 안 함).
    row lock + stale from_status 미적용(P1-1).
    """
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == step_run_id).with_for_update()
    )).scalar_one_or_none()
    if sr is None:
        return
    # S21: story 외 엔티티는 readiness matrix gating_eligible 로 판정(현 story 만)·미지원은 로그+no-op.
    _desc = get_readiness(sr.entity_type)
    if _desc is None or not _desc.gating_eligible:
        record_unsupported_entity_attempt(sr.entity_type, sr.from_status, sr.to_status, sr.entity_id)
        return
    step = await _step_config(session, sr)

    if new_status == "rejected":
        # on_reject Phase1 기본: in-review 유지·status 변경/relay 안 함(AC⑥).
        sr.status = "rejected"
        sr.resolved_at = _now()
        await session.flush()
        return

    if new_status != "approved":
        return

    on_approve = step.get("on_approve") if isinstance(step.get("on_approve"), dict) else {}
    if not on_approve.get("apply_transition"):  # AC⑤: 명시 true 일 때만 status 변경.
        sr.status = "approved"
        sr.resolved_at = _now()
        await session.flush()
        return

    # S23/S22: hypothesis/doc 는 native FSM 재사용(transition_*·parallel 0). story 는 기존 inline.
    if sr.entity_type == "hypothesis":
        await _apply_hypothesis_active(session, sr, resolver_id)
        return
    if sr.entity_type == "doc":
        await _apply_doc_confirmed(session, sr, resolver_id)
        return
    if sr.entity_type == "epic":
        await _apply_epic_transition(session, sr, resolver_id)
        return

    from app.models.pm import Story  # 순환 회피 lazy import.

    story = (await session.execute(
        select(Story).where(Story.id == sr.entity_id).with_for_update()
    )).scalar_one_or_none()
    if story is None:
        sr.status = "approved"
        sr.resolved_at = _now()
        await session.flush()
        return

    # 이미 목표 status 면 멱등 applied(다른 경로로 도달했어도 결과 동일). 그 외 stale from_status
    # (story 가 제3 status 로 이동)면 미적용(P1-1). 순서: 멱등 우선 → stale.
    if story.status == sr.to_status:
        sr.status = "applied"
        sr.resolved_at = _now()
        await session.flush()
        return
    if sr.from_status is not None and story.status != sr.from_status:
        sr.status = "skipped"
        sr.resolved_at = _now()
        await session.flush()
        return

    old_status = story.status
    story.status = sr.to_status
    sr.status = "applied"
    sr.resolved_at = _now()
    await session.flush()
    # H1 경로와 동일 side-effect(event/webhook/L1/notification·shared helper·parity·AC⑦).
    from app.services.story_status_events import emit_story_status_changed

    await emit_story_status_changed(
        session, sr.org_id, story, old_status, actor_id=resolver_id, actor_type="human",
    )


def _now():
    from datetime import datetime, timezone
    return datetime.now(tz=timezone.utc)


async def relay_agent_handoff(
    session: AsyncSession, step_run_id: uuid.UUID, sender_id: uuid.UUID | None = None,
) -> dict[str, Any] | None:
    """S7(P0-3): agent-handoff — 다음 actor 에게 dispatched relay + delivery status 가시화.

    ``dispatch_entity_to_assignee(commit=False)`` 로 호출자 트랜잭션에 합류(P1-2 partial-failure
    방지·status/step_run/event 한 트랜잭션). step_run 에 event_id/recipient_seq/delivery_status/
    delivery_error 기록. no_assignee/unresolved_assignee 는 silent pass 가 아니라 delivery_status 로
    가시화. relay 예외·미배정도 전이는 비차단(fail-open) — 호출자가 commit 후 wake 한다.

    반환: after-commit wake/delivery payload({agent_wake, delivery}) 또는 None(미배정/실패).
    """
    from app.services.agent_dispatch import dispatch_entity_to_assignee

    sr = (await session.execute(
        select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == step_run_id).with_for_update()
    )).scalar_one_or_none()
    if sr is None:
        return None
    # S21: gating_eligible 엔티티(현 story)만 handoff relay·미지원은 로그+no-op(fail-open).
    _desc = get_readiness(sr.entity_type)
    if _desc is None or not _desc.gating_eligible:
        record_unsupported_entity_attempt(sr.entity_type, sr.from_status, sr.to_status, sr.entity_id)
        return None

    trigger_metadata = {
        "source": "workflow_line",
        "line_step_id": str(sr.line_step_id) if sr.line_step_id else None,
        "step_run_id": str(sr.id),
        "from_status": sr.from_status,
        "to_status": sr.to_status,
        "correlation_id": str(sr.correlation_id),
    }
    # ⭐P0-3 fail-open: dispatch 호출을 SAVEPOINT(begin_nested)로 격리. dispatch 내부 DB 예외
    # (event flush·assign_recipient_seq·notification·L1)가 outer 트랜잭션을 aborted 로 poison하면,
    # 예외를 catch 해도 이후 dead_letter 기록·라우터 db.commit() 가 PendingRollbackError 로 깨져
    # status 전이까지 막힌다(S3 [[feedback_savepoint_failopen_session_poison]] 동류·SME 적출). savepoint
    # 면 dispatch 실패가 nested tx 로만 롤백되고 outer 는 살아있어 dead_letter 기록·전이가 진행된다.
    try:
        async with session.begin_nested():
            resp, delivery = await dispatch_entity_to_assignee(
                session, sr.org_id, sr.entity_type, sr.entity_id,
                trigger_metadata=trigger_metadata, sender_id=sender_id, commit=False,
            )
    except Exception as exc:  # noqa: BLE001 — ⭐relay 실패도 전이 비차단(fail-open)·가시화.
        # savepoint rollback 으로 outer 트랜잭션 보존됨 → dead_letter 기록이 성공한다.
        sr.delivery_status = "dead_letter"
        sr.delivery_error = f"dispatch_create: {str(exc)[:400]}"
        sr.failure_class = "dispatch_exception"
        await session.flush()
        return None

    if not resp.dispatched:
        # ⭐no_assignee/unresolved_assignee = silent pass 아님·delivery_status 로 가시화(AC⑤).
        sr.delivery_status = resp.reason or "no_assignee"
        await session.flush()
        return None

    sr.event_id = resp.event_id
    sr.recipient_seq = resp.recipient_seq
    sr.delivery_status = "queued"  # event 생성·commit 후 wake 로 전달(ACK 확정은 S8 watchdog).
    sr.status = "dispatched"
    await session.flush()

    return {
        "agent_wake": (
            {"recipient_id": str(resp.assignee_id), "recipient_seq": resp.recipient_seq}
            if resp.assignee_type == "agent" and resp.recipient_seq is not None else None
        ),
        "delivery": delivery,
    }
