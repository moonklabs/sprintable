"""Workflow Pipeline — Phase 3 Event-to-Rule pipeline.

Internal service; no API endpoint exposed.
Calls rule_evaluator.evaluate() and executes matched action.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_routing_rule import AgentRoutingRule
from app.models.workflow_execution_log import WorkflowExecutionLog
from app.services.rule_evaluator import EventContext, evaluate


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

    count_result = await session.execute(
        select(func.count()).select_from(AgentRoutingRule).where(
            AgentRoutingRule.org_id == org_id,
            AgentRoutingRule.project_id == project_id,
            AgentRoutingRule.is_enabled.is_(True),
            AgentRoutingRule.deleted_at.is_(None),
        )
    )
    if (count_result.scalar_one() or 0) == 0:
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

    try:
        side_effects = (action or {}).get("side_effects", [])
        if side_effects:
            await _execute_side_effects(session, org_id, side_effects, ctx)

        if result.log_id:
            await _update_log(session, result.log_id, "completed")

    except Exception as exc:
        if result.log_id:
            await _update_log(session, result.log_id, "failed", str(exc))
