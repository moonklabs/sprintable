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
from app.services.outcome_evidence import has_valid_outcome_evidence, has_valid_unmeasurable_reason

# overlay-gated 전이(나머지는 native 직행). matrix valid_transitions 와 일치.
_OVERLAY_TRANSITIONS = frozenset({("draft", "active"), ("active", "done")})

# story #2843(PO AC 확定 2026-08-20, doc loop-closure-first-class-signal-design §2 P1) — goal
# outcome 판정 어휘는 **기존 자동채점(cron·outcome_scorer.py) 어휘 그대로**(hit/miss) — hypothesis의
# verified/falsified를 goal에 수입하면 같은 `outcome_status` 컬럼에 두 방언이 공존해 모든 소비처가
# 영원히 둘 다 알아야 한다(기각된 안). FE 라벨만 "맞았다/틀렸다"로 다르게 보여준다.
_MANUAL_OUTCOME_STATUSES = frozenset({"hit", "miss", "unmeasurable"})
# 이미 판정된 goal(hit/miss)은 done 재전이 시 판정 재요구 안 함(旣판정 — collision 규칙②).
_ALREADY_JUDGED = frozenset({"hit", "miss"})


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
    outcome_status: str | None = None,
    outcome_result: dict | None = None,
) -> Goal:
    """goal status 전이. draft→active·active→done 는 line overlay-gated(enforcing→gate·default-off→
    inline). draft→active 는 human-only(activation=human decision). via_gate=True 면 overlay 재진입 없이
    native 직행(caller=gate approver).

    story #2843 — active→done 전이가 outcome 판정을 계약으로 받는다(`outcome_status`∈
    {hit,miss,unmeasurable}+`outcome_result`). **미제공이 전이를 막지 않는다** — outcome_status=
    unmeasured 자동 마킹으로 성립(AC1·AC5, 하드 거부는 이 스토리 스코프 밖). 旣 hit/miss(collision
    규칙②)면 판정 요구 자체를 건너뛴다. 전달된 값은 hit/miss=실측 근거(actual+reason)·
    unmeasurable=사유만 서버가 강제(§4 반증 — `outcome_evidence.py` hypothesis #2038과 공유)."""
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

    # story #2843 — done 전이의 outcome 판정. 旣판정(hit/miss)이면 재요구 없이 통과(collision②).
    if to_status == "done" and goal.outcome_status not in _ALREADY_JUDGED:
        if outcome_status is not None:
            if outcome_status not in _MANUAL_OUTCOME_STATUSES:
                raise GoalTransitionError(
                    "INVALID_OUTCOME_STATUS",
                    f"알 수 없는 outcome_status: {outcome_status} (허용: hit/miss/unmeasurable)",
                )
            if outcome_status in ("hit", "miss") and not has_valid_outcome_evidence(outcome_result):
                raise GoalTransitionError(
                    "OUTCOME_RESULT_REQUIRED",
                    "hit/miss 판정에는 실제 수치(outcome_result.actual)와 한 줄 근거"
                    "(outcome_result.reason)가 모두 필요합니다.",
                )
            if outcome_status == "unmeasurable" and not has_valid_unmeasurable_reason(outcome_result):
                raise GoalTransitionError(
                    "OUTCOME_REASON_REQUIRED",
                    "unmeasurable 선언에는 사유(outcome_result.reason)가 필요합니다.",
                )
            # story #2036과 동형(closed_by 서버 주입 — 클라 자칭 위장 차단) + collision①(cron
            # scorer skip 가드)이 읽는 source=manual 마커.
            goal.outcome_status = outcome_status
            goal.outcome_result = {
                **(outcome_result or {}),
                "source": "manual",
                "closed_by": caller.type,
                "closed_by_member_id": str(caller.id),
            }
        else:
            # 조용한 n_a 소멸이 목표 — 판정 미제공은 전이를 막지 않고 unmeasured로 명시 마킹
            # (n_a=아직 손 안 댐 vs unmeasured=닫혔는데 미판정, «닫히지 않은 루프» 카운터 축에서
            # 구분 — command_center.py/loop_measure_due.py 3곳 정합 필요).
            goal.outcome_status = "unmeasured"

    goal.status = to_status
    await session.flush()
    # BaseRepository.update()와 동형(SEE feedback_base_repository_refresh) — updated_at이
    # onupdate=func.now() 서버생성값이라 flush만으로는 파이썬 객체에 반영 안 되고 unloaded 상태로
    # 남는다. 이후 GoalResponse.model_validate(from_attributes)가 동기 컨텍스트에서 이 속성을
    # 읽으려 하면 lazy-load가 트리거돼 MissingGreenlet 500(story는 BaseRepository.update() 경유라
    # refresh가 이미 있어 무증상 — goal만 직접 mutation이라 누락됐던 것).
    await session.refresh(goal)
    return goal
