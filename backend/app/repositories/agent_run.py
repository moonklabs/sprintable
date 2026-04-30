from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_run import AgentRun


class AgentRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(
        self,
        project_id: uuid.UUID,
        agent_id: uuid.UUID | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> list[AgentRun]:
        from app.models.team import TeamMember
        agent_ids_q = select(TeamMember.id).where(TeamMember.project_id == project_id)
        agent_ids_r = await self.session.execute(agent_ids_q)
        agent_ids = [r[0] for r in agent_ids_r.all()]

        q = select(AgentRun).where(AgentRun.agent_id.in_(agent_ids))
        if agent_id is not None:
            q = q.where(AgentRun.agent_id == agent_id)
        if cursor:
            q = q.where(AgentRun.created_at < cursor)
        q = q.order_by(AgentRun.created_at.desc()).limit(min(limit, 200))
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get(self, id: uuid.UUID) -> AgentRun | None:
        result = await self.session.execute(
            select(AgentRun).where(AgentRun.id == id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        org_id: uuid.UUID,
        agent_id: uuid.UUID,
        trigger: str = "manual",
        **kwargs: Any,
    ) -> AgentRun:
        run = AgentRun(org_id=org_id, agent_id=agent_id, trigger=trigger, **kwargs)
        self.session.add(run)
        await self.session.flush()
        await self.session.refresh(run)
        return run

    async def update(self, id: uuid.UUID, **fields: Any) -> AgentRun | None:
        run = await self.get(id)
        if run is None:
            return None
        for k, v in fields.items():
            if v is not None or k in ("result_summary", "last_error_code"):
                setattr(run, k, v)
        await self.session.flush()
        await self.session.refresh(run)
        return run
