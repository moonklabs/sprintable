"""E-DG S25: goal(구 epic) decision lifecycle 전이 서비스.

goal native status(draft|active|done|archived)를 hypothesis/doc 동형 패턴으로 전이한다. ⭐**TWO
overlay-gated 전이**: draft→active(activation·human-gate) + active→done(completion·aggregate-gate).
나머지(archive 류)는 native 직행. ``via_gate=True`` = Decision Gate 승인 적용 경로(overlay 재진입 차단).

계층 리네이밍 B1(story 1925): 구 services/epic.py — 클래스/함수명만 rename. `entity_type="epic"`
문자열(workflow_line_engine·gate_approval 등 크로스커팅 polymorphic discriminator, DB persisted rows
포함 가능성)은 B1 스코프 밖(변경 시 별도 데이터 마이그 필요) — 그대로 유지.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Goal
from app.schemas.goal import GOAL_STATUSES, is_valid_goal_transition
from app.services.member_resolver import ResolvedMember

# overlay-gated 전이(나머지는 native 직행). matrix valid_transitions 와 일치.
_OVERLAY_TRANSITIONS = frozenset({("draft", "active"), ("active", "done")})


class GoalTransitionError(Exception):
    """도메인 오류 — 라우터가 code/message 를 HTTPException 으로 매핑."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def transition_goal(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    goal_id: uuid.UUID,
    to_status: str,
    via_gate: bool = False,
) -> Goal:
    """goal status 전이. draft→active·active→done 는 line overlay-gated(enforcing→gate·default-off→
    inline). draft→active 는 human-only(activation=human decision). via_gate=True 면 overlay 재진입 없이
    native 직행(caller=gate approver)."""
    goal = (await session.execute(
        select(Goal).where(Goal.id == goal_id, Goal.org_id == org_id)
    )).scalar_one_or_none()
    if goal is None:
        raise GoalTransitionError("EPIC_NOT_FOUND", "목표를 찾을 수 없습니다.")

    if to_status not in GOAL_STATUSES:
        raise GoalTransitionError("INVALID_STATUS", f"알 수 없는 goal status: {to_status}")
    if not is_valid_goal_transition(goal.status, to_status):
        raise GoalTransitionError(
            "INVALID_EPIC_TRANSITION", f"불법 전이: {goal.status} → {to_status}"
        )

    # ⭐E-DG S25: draft→active / active→done line overlay. enforcing 라인이면 gate 생성·status 유지
    # (가시 결재 대기). default-off/plain/엔진실패 → 아래 inline 폴백(byte-동일·⚠️fail-open=통과 아님).
    # via_gate(gate 승인 적용)면 overlay skip. active→done 의 routing_context aggregate 는 resolver 가 산출.
    if (goal.status, to_status) in _OVERLAY_TRANSITIONS and not via_gate:
        _decision = None
        try:
            from app.services.workflow_line_engine import evaluate_line_for_transition
            _decision = await evaluate_line_for_transition(
                session, org_id=org_id, project_id=goal.project_id,
                entity_type="epic", entity_id=goal.id,
                from_status=goal.status, to_status=to_status,
                actor_id=caller.id, actor_type=caller.type,
            )
        except Exception:  # noqa: BLE001 — fail-open: 엔진 실패는 inline 폴백(차단 유지).
            _decision = None
        if _decision is not None and not _decision.proceeds:
            await session.commit()  # gate/step_run 보존(stories.py:736 패턴).
            return goal

    # activation(draft→active)은 휴먼만(PO/owner decision). active→done 은 inline 시 caller 권한(라우터 보강).
    if to_status == "active" and caller.type != "human":
        raise GoalTransitionError("HUMAN_CONFIRM_REQUIRED", "active(activation) 전이는 휴먼만 가능합니다.")

    goal.status = to_status
    await session.flush()
    # BaseRepository.update()와 동형(SEE feedback_base_repository_refresh) — updated_at이
    # onupdate=func.now() 서버생성값이라 flush만으로는 파이썬 객체에 반영 안 되고 unloaded 상태로
    # 남는다. 이후 GoalResponse.model_validate(from_attributes)가 동기 컨텍스트에서 이 속성을
    # 읽으려 하면 lazy-load가 트리거돼 MissingGreenlet 500(story는 BaseRepository.update() 경유라
    # refresh가 이미 있어 무증상 — goal만 직접 mutation이라 누락됐던 것).
    await session.refresh(goal)
    return goal
