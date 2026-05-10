"""Rule Evaluator — Phase 3 Rule Evaluation Engine.

Internal service only; no API endpoint exposed.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_routing_rule import AgentRoutingRule
from app.models.workflow_execution_log import WorkflowExecutionLog


class EventMetadata(BaseModel):
    """Structured schema for EventContext.metadata. extra='allow' preserves legacy flat keys."""

    model_config = {"extra": "allow"}

    story_id: str | None = None
    story_title: str | None = None
    story_status: str | None = None
    story_priority: str | None = None
    epic_id: str | None = None
    epic_title: str | None = None
    actor_id: str | None = None
    actor_name: str | None = None
    actor_role: str | None = None
    memo_id: str | None = None
    memo_type: str | None = None
    title: str | None = None
    context_message: str | None = None


@dataclass
class EventContext:
    event_type: str
    trigger_type_slug: str | None = None
    memo_type: str | None = None
    memo_id: str | None = None
    actor_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    is_side_effect: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.event_type,
            "trigger_type_slug": self.trigger_type_slug,
            "memo_type": self.memo_type,
            "memo_id": self.memo_id,
            "actor_id": self.actor_id,
            "metadata": self.metadata,
        }


@dataclass
class EvaluationResult:
    matched: bool
    rule: AgentRoutingRule | None
    action: dict[str, Any] | None
    target_agent_id: uuid.UUID | None
    log_id: uuid.UUID | None = None


def _matches(rule: AgentRoutingRule, ctx: EventContext) -> bool:
    conditions: dict[str, Any] = rule.conditions or {}

    trigger_slugs: list[str] = conditions.get("trigger_type_slugs") or []
    if trigger_slugs:
        if ctx.trigger_type_slug not in trigger_slugs:
            return False

    memo_types: list[str] = conditions.get("memo_type") or []
    if memo_types:
        if ctx.memo_type not in memo_types:
            return False

    event_params: dict[str, Any] = conditions.get("event_params") or {}
    for key, allowed_values in event_params.items():
        if not isinstance(allowed_values, list) or not allowed_values:
            continue
        actual = ctx.metadata.get(key)
        if actual not in allowed_values:
            return False

    return True


async def evaluate(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    ctx: EventContext,
) -> EvaluationResult:
    started = time.monotonic()

    result = await session.execute(
        select(AgentRoutingRule)
        .where(
            AgentRoutingRule.org_id == org_id,
            AgentRoutingRule.project_id == project_id,
            AgentRoutingRule.is_enabled.is_(True),
            AgentRoutingRule.deleted_at.is_(None),
        )
        .order_by(AgentRoutingRule.priority.asc(), AgentRoutingRule.created_at.asc())
    )
    rules = list(result.scalars().all())

    matched_rule: AgentRoutingRule | None = None
    for rule in rules:
        if _matches(rule, ctx):
            matched_rule = rule
            break

    duration_ms = int((time.monotonic() - started) * 1000)

    action = matched_rule.action if matched_rule else None
    target_agent_id: uuid.UUID | None = None
    if matched_rule:
        target_agent_id = matched_rule.agent_id

    log = WorkflowExecutionLog(
        org_id=org_id,
        project_id=project_id,
        rule_id=matched_rule.id if matched_rule else None,
        event_type=ctx.event_type,
        trigger_type_slug=ctx.trigger_type_slug,
        event_context=ctx.to_dict(),
        action=action,
        target_agent_id=target_agent_id,
        status="matched" if matched_rule else "no_match",
        duration_ms=duration_ms,
        completed_at=datetime.now(timezone.utc),
    )
    session.add(log)
    await session.flush()

    return EvaluationResult(
        matched=matched_rule is not None,
        rule=matched_rule,
        action=action,
        target_agent_id=target_agent_id,
        log_id=log.id,
    )
