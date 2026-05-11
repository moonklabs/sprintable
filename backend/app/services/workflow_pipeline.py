"""Workflow Pipeline — Phase 3 Event-to-Rule pipeline.

Internal service; no API endpoint exposed.
Calls rule_evaluator.evaluate() and executes matched action (send/forward memo).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_execution_log import WorkflowExecutionLog
from app.services.rule_evaluator import EventContext, evaluate


def _build_memo_title(ctx: EventContext) -> str:
    titles = {
        "story.status_changed": "스토리 상태 변경",
        "story.assignee_changed": "스토리 담당자 변경",
        "memo.created": "새 메모",
        "memo_created": "새 메모",
    }
    return titles.get(ctx.event_type, f"[{ctx.event_type}] 이벤트")


def _build_memo_content(ctx: EventContext) -> str:
    lines = [f"**이벤트:** {ctx.event_type}"]
    if ctx.trigger_type_slug:
        lines.append(f"**트리거:** {ctx.trigger_type_slug}")
    if ctx.memo_type:
        lines.append(f"**메모 타입:** {ctx.memo_type}")
    if ctx.memo_id:
        lines.append(f"**메모 ID:** {ctx.memo_id}")
    for k, v in (ctx.metadata or {}).items():
        lines.append(f"**{k}:** {v}")
    return "\n".join(lines)


async def _send_memo(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    agent_id: uuid.UUID,
    ctx: EventContext,
) -> None:
    from app.repositories.memo import MemoRepository
    repo = MemoRepository(session, org_id)
    created_by: uuid.UUID | None = None
    if ctx.actor_id:
        try:
            created_by = uuid.UUID(str(ctx.actor_id))
        except ValueError:
            pass
    await repo.create(
        project_id=project_id,
        content=_build_memo_content(ctx),
        memo_type="task",
        title=_build_memo_title(ctx),
        assigned_to=agent_id,
        created_by=created_by,
        memo_metadata={"origin": "workflow"},
    )


async def _execute_side_effects(
    session: AsyncSession,
    org_id: uuid.UUID,
    side_effects: list[dict],
    ctx: EventContext,
) -> None:
    from app.models.pm import Story
    from app.models.team import TeamMember

    story_id_str = ctx.metadata.get("story_id")

    for se in side_effects:
        try:
            effect_type = se.get("type")
            if effect_type == "update_status" and story_id_str:
                target_status = se.get("target_status")
                if target_status:
                    await session.execute(
                        update(Story)
                        .where(Story.id == uuid.UUID(str(story_id_str)), Story.org_id == org_id)
                        .values(status=target_status)
                    )
            elif effect_type == "auto_assign" and story_id_str:
                role = se.get("assign_to_role")
                if role:
                    result = await session.execute(
                        select(TeamMember.id)
                        .where(TeamMember.org_id == org_id, TeamMember.role == role)
                        .limit(1)
                    )
                    member_id = result.scalar_one_or_none()
                    if member_id:
                        await session.execute(
                            update(Story)
                            .where(Story.id == uuid.UUID(str(story_id_str)), Story.org_id == org_id)
                            .values(assignee_id=member_id)
                        )
        except Exception:
            pass


async def _update_log(
    session: AsyncSession,
    log_id: uuid.UUID,
    status: str,
    error_message: str | None = None,
) -> None:
    values: dict[str, Any] = {
        "status": status,
        "completed_at": datetime.now(timezone.utc),
    }
    if error_message:
        values["error_message"] = error_message
    await session.execute(
        update(WorkflowExecutionLog)
        .where(WorkflowExecutionLog.id == log_id)
        .values(**values)
    )


async def process_event(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    ctx: EventContext,
) -> None:
    if ctx.is_side_effect:
        return

    result = await evaluate(session, org_id, project_id, ctx)

    if not result.matched or not result.action:
        return

    if result.log_id:
        await session.execute(
            update(WorkflowExecutionLog)
            .where(WorkflowExecutionLog.id == result.log_id)
            .values(status="running")
        )

    action = result.action
    mode = action.get("auto_reply_mode", "process_and_report")

    try:
        if mode == "process_and_report" and result.target_agent_id:
            await _send_memo(session, org_id, project_id, result.target_agent_id, ctx)

        elif mode == "process_and_forward":
            fwd_str = action.get("forward_to_agent_id")
            if fwd_str:
                try:
                    fwd_id = uuid.UUID(str(fwd_str))
                    await _send_memo(session, org_id, project_id, fwd_id, ctx)
                except ValueError:
                    raise ValueError(f"Invalid forward_to_agent_id: {fwd_str}")

        side_effects = (action or {}).get("side_effects", [])
        if side_effects:
            await _execute_side_effects(session, org_id, side_effects, ctx)

        if result.log_id:
            await _update_log(session, result.log_id, "completed")

    except Exception as exc:
        if result.log_id:
            await _update_log(session, result.log_id, "failed", str(exc))
