"""E-LOOP-LEDGER S3: LoopRun repository — CRUD(BaseRepository) + 필터드 list."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.loop import LoopRun
from app.repositories.base import BaseRepository


class LoopRunRepository(BaseRepository[LoopRun]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(LoopRun, session, org_id)

    async def list_filtered(
        self,
        *,
        project_id: uuid.UUID,
        status: str | None = None,
        parent_loop_id: uuid.UUID | None = None,
        goal_tag: str | None = None,
        limit: int = 100,
    ) -> list[LoopRun]:
        q = select(LoopRun).where(
            LoopRun.org_id == self.org_id,
            LoopRun.project_id == project_id,
            LoopRun.deleted_at.is_(None),
        )
        if status is not None:
            q = q.where(LoopRun.status == status)
        if parent_loop_id is not None:
            q = q.where(LoopRun.parent_loop_id == parent_loop_id)
        if goal_tag is not None:
            q = q.where(LoopRun.goal_tags.any(goal_tag))
        q = q.order_by(LoopRun.created_at.desc(), LoopRun.id.desc()).limit(limit)
        return list((await self.session.execute(q)).scalars().all())
