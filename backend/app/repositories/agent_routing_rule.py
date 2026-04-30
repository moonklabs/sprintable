from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_routing_rule import AgentRoutingRule
from app.schemas.agent_routing_rule import RoutingRuleResponse

_DEFAULT_RUNTIME = "openclaw"
_DEFAULT_MATCH_TYPE = "event"


def _normalize_conditions(value: Any) -> dict[str, Any]:
    if not value or not isinstance(value, dict):
        return {"memo_type": []}
    memo_type = value.get("memo_type", [])
    if not isinstance(memo_type, list):
        memo_type = []
    return {"memo_type": [str(m).strip().lower() for m in memo_type if str(m).strip()]}


def _normalize_action(value: Any) -> dict[str, Any]:
    if not value or not isinstance(value, dict):
        return {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None}
    mode = value.get("auto_reply_mode", "process_and_report")
    if mode not in ("process_and_forward", "process_and_report"):
        mode = "process_and_report"
    fwd = value.get("forward_to_agent_id")
    if mode == "process_and_forward" and isinstance(fwd, str) and fwd.strip():
        forward_to = fwd.strip()
    else:
        forward_to = None
    return {"auto_reply_mode": mode, "forward_to_agent_id": forward_to}


def _to_response(rule: AgentRoutingRule) -> RoutingRuleResponse:
    return RoutingRuleResponse(
        id=rule.id,
        org_id=rule.org_id,
        project_id=rule.project_id,
        agent_id=rule.agent_id,
        persona_id=rule.persona_id,
        deployment_id=rule.deployment_id,
        name=rule.name,
        priority=rule.priority,
        match_type=rule.match_type,
        conditions=_normalize_conditions(rule.conditions),
        action=_normalize_action(rule.action),
        target_runtime=rule.target_runtime,
        target_model=rule.target_model,
        is_enabled=rule.is_enabled,
        metadata=rule.rule_metadata or {},
        created_by=rule.created_by,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


class AgentRoutingRuleRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self, org_id: uuid.UUID, project_id: uuid.UUID) -> list[RoutingRuleResponse]:
        r = await self.session.execute(
            select(AgentRoutingRule)
            .where(
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == project_id,
                AgentRoutingRule.deleted_at.is_(None),
            )
            .order_by(AgentRoutingRule.priority.asc(), AgentRoutingRule.created_at.asc())
        )
        return [_to_response(rule) for rule in r.scalars().all()]

    async def get(self, rule_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> RoutingRuleResponse | None:
        r = await self.session.execute(
            select(AgentRoutingRule).where(
                AgentRoutingRule.id == rule_id,
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == project_id,
                AgentRoutingRule.deleted_at.is_(None),
            )
        )
        rule = r.scalar_one_or_none()
        return _to_response(rule) if rule else None

    async def create(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        agent_id: uuid.UUID,
        name: str,
        priority: int = 100,
        match_type: str = _DEFAULT_MATCH_TYPE,
        conditions: dict | None = None,
        action: dict | None = None,
        target_runtime: str = _DEFAULT_RUNTIME,
        target_model: str | None = None,
        is_enabled: bool = True,
        persona_id: uuid.UUID | None = None,
        deployment_id: uuid.UUID | None = None,
    ) -> RoutingRuleResponse:
        rule = AgentRoutingRule(
            org_id=org_id,
            project_id=project_id,
            agent_id=agent_id,
            persona_id=persona_id,
            deployment_id=deployment_id,
            name=name.strip(),
            priority=priority,
            match_type=match_type or _DEFAULT_MATCH_TYPE,
            conditions=_normalize_conditions(conditions),
            action=_normalize_action(action),
            target_runtime=(target_runtime or _DEFAULT_RUNTIME).strip(),
            target_model=target_model.strip() if target_model else None,
            is_enabled=is_enabled,
            rule_metadata={},
            created_by=actor_id,
        )
        self.session.add(rule)
        await self.session.flush()
        await self.session.refresh(rule)
        return _to_response(rule)

    async def update(
        self,
        rule_id: uuid.UUID,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        **fields: Any,
    ) -> RoutingRuleResponse | None:
        r = await self.session.execute(
            select(AgentRoutingRule).where(
                AgentRoutingRule.id == rule_id,
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == project_id,
                AgentRoutingRule.deleted_at.is_(None),
            )
        )
        rule = r.scalar_one_or_none()
        if rule is None:
            return None

        patch: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
        if "name" in fields and fields["name"]:
            patch["name"] = fields["name"].strip()
        if "agent_id" in fields and fields["agent_id"]:
            patch["agent_id"] = fields["agent_id"]
        if "persona_id" in fields:
            patch["persona_id"] = fields["persona_id"]
        if "deployment_id" in fields:
            patch["deployment_id"] = fields["deployment_id"]
        if "priority" in fields and fields["priority"] is not None:
            patch["priority"] = fields["priority"]
        if "match_type" in fields and fields["match_type"]:
            patch["match_type"] = fields["match_type"]
        if "conditions" in fields:
            patch["conditions"] = _normalize_conditions(fields["conditions"])
        if "action" in fields:
            patch["action"] = _normalize_action(fields["action"])
        if "target_runtime" in fields and fields["target_runtime"]:
            patch["target_runtime"] = fields["target_runtime"].strip()
        if "target_model" in fields:
            val = fields["target_model"]
            patch["target_model"] = val.strip() if val else None
        if "is_enabled" in fields and fields["is_enabled"] is not None:
            patch["is_enabled"] = fields["is_enabled"]
        if "metadata" in fields and fields["metadata"] is not None:
            patch["rule_metadata"] = fields["metadata"]

        await self.session.execute(
            update(AgentRoutingRule).where(AgentRoutingRule.id == rule_id).values(**patch)
        )
        await self.session.flush()
        await self.session.refresh(rule)
        return _to_response(rule)

    async def replace(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        items: list[dict],
    ) -> list[RoutingRuleResponse]:
        await self.session.execute(
            text("SELECT replace_agent_routing_rules(:org_id, :project_id, :actor_id, :rules::jsonb)"),
            {
                "org_id": str(org_id),
                "project_id": str(project_id),
                "actor_id": str(actor_id),
                "rules": json.dumps(items),
            },
        )
        await self.session.flush()
        return await self.list(org_id, project_id)

    async def reorder(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        items: list[dict],
    ) -> list[RoutingRuleResponse]:
        now = datetime.now(timezone.utc)
        for item in items:
            await self.session.execute(
                update(AgentRoutingRule)
                .where(
                    AgentRoutingRule.id == uuid.UUID(str(item["id"])),
                    AgentRoutingRule.org_id == org_id,
                    AgentRoutingRule.project_id == project_id,
                    AgentRoutingRule.deleted_at.is_(None),
                )
                .values(priority=item["priority"], updated_at=now)
            )
        await self.session.flush()
        return await self.list(org_id, project_id)

    async def disable_all(self, org_id: uuid.UUID, project_id: uuid.UUID) -> list[RoutingRuleResponse]:
        await self.session.execute(
            update(AgentRoutingRule)
            .where(
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == project_id,
                AgentRoutingRule.deleted_at.is_(None),
            )
            .values(is_enabled=False, updated_at=datetime.now(timezone.utc))
        )
        await self.session.flush()
        return await self.list(org_id, project_id)

    async def delete(self, rule_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> bool:
        r = await self.session.execute(
            select(AgentRoutingRule).where(
                AgentRoutingRule.id == rule_id,
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == project_id,
                AgentRoutingRule.deleted_at.is_(None),
            )
        )
        rule = r.scalar_one_or_none()
        if rule is None:
            return False
        await self.session.execute(
            update(AgentRoutingRule)
            .where(AgentRoutingRule.id == rule_id)
            .values(deleted_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
        )
        await self.session.flush()
        return True
