"""WorkflowTemplate repository — S5-1."""
from __future__ import annotations

import copy
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_template import WorkflowTemplate


class WorkflowTemplateRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self) -> list[WorkflowTemplate]:
        result = await self.session.execute(
            select(WorkflowTemplate)
            .where(WorkflowTemplate.is_enabled.is_(True))
            .order_by(WorkflowTemplate.chain_length.asc())
        )
        return list(result.scalars().all())

    async def get_by_slug(self, slug: str) -> WorkflowTemplate | None:
        result = await self.session.execute(
            select(WorkflowTemplate).where(WorkflowTemplate.slug == slug)
        )
        return result.scalar_one_or_none()


def resolve_rules_template(
    rules_template: list[dict],
    role_map: dict[str, dict[str, Any]],
) -> list[dict]:
    """role_ref placeholder를 실제 agent_id/name으로 치환.

    role_map: {"step_1": {"agent_id": "...", "agent_name": "...", ...}, ...}
    """
    resolved = []
    for rule in rules_template:
        r = copy.deepcopy(rule)
        role_ref = r.pop("role_ref", None)
        agent_info = role_map.get(role_ref or "") if role_ref else None
        if agent_info:
            r["agent_id"] = agent_info.get("agent_id")
            r["persona_id"] = agent_info.get("persona_id")
            r["deployment_id"] = agent_info.get("deployment_id")
            r["target_runtime"] = agent_info.get("target_runtime", "openclaw")
            r["target_model"] = agent_info.get("target_model")
            r["is_enabled"] = True
        resolved.append(r)
    return resolved
