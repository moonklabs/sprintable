"""E-DECISION-GATE S6: gate 전이 → 범용 line resolution 배선.

gate 승인/반려가 ``transition_gate()`` 를 타면, 그 gate 에 묶인 active line step_run 을 찾아 line
정책대로 status 를 적용한다. H1 approve 와 line approve 가 **동일 status side-effect 경로**
(``emit_story_status_changed``)를 타도록 통일한다(신규 승인경로 0). line run 이 없으면 호출부가
legacy ``_advance_story_on_merge_approve`` 로 폴백한다(무회귀).

P1-1 idempotency: story/run 을 row lock(SELECT FOR UPDATE)하고, stale ``from_status``(story 가 이미
다른 status 로 이동)면 적용하지 않는다. 이미 목표 status 면 no-op.
"""
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import (
    WorkflowLineDefinition,
    WorkflowLineDefinitionVersion,
    WorkflowLineStepRun,
)

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
    if sr is None or sr.entity_type != "story":  # Phase1 = story-only
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
