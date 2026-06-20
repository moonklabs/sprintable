"""E-DG S26: sprint status contract 전이 서비스 (단일 경로 SSOT).

sprint enum/전이를 hypothesis/epic 동형 패턴으로 정형화. ⭐overlay-gated = 시작(planning→active)·
마감(active→done·review→done). ③SoD 없음(sprint=project 운영·member 필드 없음)·단 **human-gate**
(agent 가 sprint 시작/마감 self 금지). gate advisory(dispatch는 S27까지 금지·AC). 기존 activate/close
repo 로직(1-active 제약·velocity)에 위임해 보존. ``via_gate=True`` = gate 승인 적용(overlay 재진입 차단).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.sprint import SprintRepository
from app.schemas.sprint import SPRINT_STATUSES, is_valid_sprint_transition
from app.services.member_resolver import ResolvedMember

# overlay-gated 전이(나머지 archive 는 native). matrix valid_transitions 와 일치.
_OVERLAY_TRANSITIONS = frozenset({("planning", "active"), ("active", "closed"), ("review", "closed")})


class SprintTransitionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def transition_sprint(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    sprint_id: uuid.UUID,
    to_status: str,
    via_gate: bool = False,
):
    """sprint status 전이(단일 SSOT). 시작/마감 overlay(advisory)·human-only. apply 는 기존 repo.activate
    (1-active 제약)/repo.close(velocity)에 위임. review/archived 는 inline. via_gate=True 면 overlay skip."""
    repo = SprintRepository(session, org_id)
    sprint = await repo.get(sprint_id)
    if sprint is None:
        raise SprintTransitionError("SPRINT_NOT_FOUND", "스프린트를 찾을 수 없습니다.")
    if to_status not in SPRINT_STATUSES:
        raise SprintTransitionError("INVALID_STATUS", f"알 수 없는 sprint status: {to_status}")
    if not is_valid_sprint_transition(sprint.status, to_status):
        raise SprintTransitionError(
            "INVALID_SPRINT_TRANSITION", f"불법 전이: {sprint.status} → {to_status}"
        )

    gated = (sprint.status, to_status) in _OVERLAY_TRANSITIONS
    # ⭐S26: 시작/마감 line overlay(advisory). enforcing 라인이면 gate 생성·status 유지. default-off/
    # plain/엔진실패 → 아래 inline 폴백. via_gate(gate 승인)면 skip.
    if gated and not via_gate:
        _decision = None
        try:
            from app.services.workflow_line_engine import evaluate_line_for_transition
            _decision = await evaluate_line_for_transition(
                session, org_id=org_id, project_id=sprint.project_id,
                entity_type="sprint", entity_id=sprint.id,
                from_status=sprint.status, to_status=to_status,
                actor_id=caller.id, actor_type=caller.type,
            )
        except Exception:  # noqa: BLE001 — fail-open: 엔진 실패는 inline 폴백.
            _decision = None
        if _decision is not None and not _decision.proceeds:
            await session.commit()  # gate/step_run 보존(stories.py:736 패턴).
            return sprint

    # ③human-gate = enforcing gate(gates.py _HUMAN_REVIEW_STATUSES human-only·RC① caller 강제)가 담당.
    # ⚠️여기 inline human-only 안 검(sprint activate/close 는 기존에 human-check 없어 default-off agent
    # 흐름[MCP activate/checkin] 보존 필수). agent self 금지는 enforcing gate 가 봉인(SoD는 없음·③).

    # apply: 기존 repo 로직 위임(로직 보존). ValueError(1-active 등)는 라우터가 매핑.
    if to_status == "active":
        return await repo.activate(sprint_id)   # planning→active·1-active 제약
    if to_status == "closed":
        return await repo.close(sprint_id)      # active|review→closed·velocity 집계(repo.close=closed set)
    # review·archived: 특수 로직 없음 → inline.
    updated = await repo.update(sprint_id, status=to_status)
    return updated
