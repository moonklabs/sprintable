from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_version import WorkflowVersion
from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
from app.schemas.agent_routing_rule import RoutingRuleResponse
from app.schemas.workflow_version import ChangeSummary, WorkflowVersionResponse


def _to_response(row: WorkflowVersion) -> WorkflowVersionResponse:
    raw_summary = row.change_summary or {}
    return WorkflowVersionResponse(
        id=row.id,
        org_id=row.org_id,
        project_id=row.project_id,
        version=row.version,
        snapshot=row.snapshot or [],
        change_summary=ChangeSummary(
            added_rules=raw_summary.get("added_rules", 0),
            removed_rules=raw_summary.get("removed_rules", 0),
            changed_rules=raw_summary.get("changed_rules", 0),
        ),
        created_by=row.created_by,
        created_at=row.created_at,
    )


class WorkflowVersionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(self, org_id: uuid.UUID, project_id: uuid.UUID) -> list[WorkflowVersionResponse]:
        result = await self.session.execute(
            select(WorkflowVersion)
            .where(
                WorkflowVersion.org_id == org_id,
                WorkflowVersion.project_id == project_id,
            )
            .order_by(WorkflowVersion.version.desc())
        )
        return [_to_response(row) for row in result.scalars().all()]

    async def get(self, version_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> WorkflowVersion | None:
        result = await self.session.execute(
            select(WorkflowVersion).where(
                WorkflowVersion.id == version_id,
                WorkflowVersion.org_id == org_id,
                WorkflowVersion.project_id == project_id,
            )
        )
        return result.scalar_one_or_none()

    async def rollback(
        self,
        version_id: uuid.UUID,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> list[RoutingRuleResponse] | None:
        row = await self.get(version_id, org_id, project_id)
        if row is None:
            return None

        snapshot_items = row.snapshot or []
        rule_repo = AgentRoutingRuleRepository(self.session)
        return await rule_repo.replace(
            org_id=org_id,
            project_id=project_id,
            actor_id=actor_id,
            items=snapshot_items,
        )
