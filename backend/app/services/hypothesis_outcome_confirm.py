"""story #2857(loop-closure P2-B) — 측정 판정 초안=에이전트·확定=휴먼.

metric_definition의 source가 자동채점 대상(ga4/internal_ops)이 아닌 hypothesis(§2845
큐가 표면화하는 measuring 축)를 위한 흐름: 에이전트가 측정을 실행해 판정 초안을 만들고,
사람이 기존 게이트 판에서 승인해야 실제로 hypothesis가 verified/falsified/killed로
전이한다("판정 기계+휴먼 승인" — merge/doc gate와 동형 구조, 새 authz 발명 0).

초안 보관소는 Hypothesis에 새 컬럼을 얹지 않고 ``Gate.neutral_facts``를 재사용한다 —
그 필드가 이미 "에이전트가 계산한 사실, 사람 판정 대기"라는 정확히 이 목적으로 설계돼
있다(create_gate() 전역 chokepoint 그대로). ``Hypothesis.draft_metadata``는 다른 개념
(가설 «문장» 저작 시 LLM 초안 추적, hypothesis.py:708)이라 재사용하면 confound된다 —
페드루 PO 판정(2026-08-20)으로 배제 확定.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.hypothesis import Hypothesis, is_valid_transition

HYPOTHESIS_OUTCOME_CONFIRM_GATE_TYPE = "hypothesis_outcome_confirm"

# measuring에서 도달 가능한 해소 상태만 초안 대상(§2.5 상태기계 그대로 — 새 전이 발명 0).
_DRAFTABLE_TARGETS = frozenset({"verified", "falsified", "killed"})


class HypothesisOutcomeConfirmError(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


async def draft_hypothesis_outcome(
    session: AsyncSession,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    hypothesis_id: uuid.UUID,
    *,
    draft_target: str,
    draft_actual: Any,
    draft_reason: str,
) -> Gate:
    """에이전트가 측정 판정 초안을 제출 — Gate row(항상 pending·human-only 승인)로 대기.

    create_gate()의 멱등 chokepoint를 그대로 쓴다(같은 hypothesis에 재제출해도 새 gate
    난립 없음 — 기존 pending/approved/rejected 게이트가 있으면 그 규칙 그대로 따른다).
    role_id — merge 게이트처럼 자연 참여-역할이 없어 doc.py의 기본 결재 role 폴백 패턴을
    그대로 재사용(_default_role_id, 없으면 hypothesis_id를 placeholder로 — FK 비강제라 무해,
    doc.py:121과 동형).
    """
    if draft_target not in _DRAFTABLE_TARGETS:
        raise HypothesisOutcomeConfirmError(
            "INVALID_DRAFT_TARGET", f"draft_target은 {sorted(_DRAFTABLE_TARGETS)} 중 하나여야 합니다.",
        )
    hyp = (await session.execute(
        select(Hypothesis).where(Hypothesis.id == hypothesis_id, Hypothesis.org_id == org_id)
    )).scalar_one_or_none()
    if hyp is None:
        raise HypothesisOutcomeConfirmError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    if hyp.status != "measuring":
        raise HypothesisOutcomeConfirmError(
            "NOT_MEASURING", f"measuring 상태만 판정 초안 대상입니다(현재={hyp.status}).",
        )
    if not is_valid_transition(hyp.status, draft_target):
        raise HypothesisOutcomeConfirmError(
            "INVALID_HYPOTHESIS_TRANSITION", f"불법 전이: {hyp.status} → {draft_target}",
        )

    from app.services.gate_service import create_gate
    from app.services.workflow_line_config import _default_role_id

    role_id = await _default_role_id(session, org_id) or hypothesis_id

    gate = await create_gate(
        session, org_id, hypothesis_id, "hypothesis", HYPOTHESIS_OUTCOME_CONFIRM_GATE_TYPE,
        member_id, role_id,
        neutral_facts={
            "draft_target": draft_target,
            "draft_actual": draft_actual,
            "draft_reason": draft_reason,
        },
        project_id=hyp.project_id,
    )
    return gate


async def resolve_hypothesis_outcome_confirm_gate(
    session: AsyncSession, gate: Gate, new_status: str, resolver_id: uuid.UUID | None,
) -> None:
    """게이트 해소 → hypothesis 실 전이(승인 시만). transition_gate()의 기존 gate_type
    dispatch 대열(_resolve_doc_gate 등과 동형 자리)에 얹는다 — pending 아니면/타 gate_type
    이면 no-op.

    caller는 이 게이트 승인 라우터(transition_gate_endpoint)가 이미 human-only로 강제한
    resolver 그대로(93fc7aeb) — 여기서 재검증하지 않는다(via_gate=True가 그 전제를 명시).
    """
    if gate.work_item_type != "hypothesis" or gate.gate_type != HYPOTHESIS_OUTCOME_CONFIRM_GATE_TYPE:
        return
    if new_status != "approved":
        return  # rejected/voided는 그냥 소거 — hypothesis는 measuring 그대로(다시 초안 가능).

    hyp = (await session.execute(
        select(Hypothesis).where(Hypothesis.id == gate.work_item_id, Hypothesis.org_id == gate.org_id)
    )).scalar_one_or_none()
    if hyp is None or hyp.status != "measuring":
        return  # 멱등 — 이미 다른 경로로 해소됐거나 삭제됨.

    facts = gate.neutral_facts or {}
    target = facts.get("draft_target")
    if target not in _DRAFTABLE_TARGETS:
        return  # 방어(있을 수 없는 상태 — 조용히 no-op, 새 판정 로직 0).

    from app.schemas.hypothesis import HypothesisTransition
    from app.services.hypothesis import transition_hypothesis

    payload = HypothesisTransition(
        status=target,
        outcome_result=(
            {"actual": facts.get("draft_actual"), "reason": facts.get("draft_reason")}
            if target in ("verified", "falsified") else None
        ),
        note=facts.get("draft_reason") if target == "killed" else None,
    )
    # caller — transition_gate_endpoint가 이미 human-only 강제(93fc7aeb) 후 넘어온 resolver.
    # transition_hypothesis는 caller.id/caller.type만 읽는다(via_gate 경로 전용 최소 duck-type).
    caller = SimpleNamespace(id=resolver_id, type="human")
    await transition_hypothesis(session, gate.org_id, caller, hyp.id, payload, via_gate=True)
