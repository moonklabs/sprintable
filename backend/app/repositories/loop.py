"""E-LOOP-LEDGER S3/S4: LoopRun + LoopArtifact repository — CRUD(BaseRepository) + 필터드 list."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.loop import LoopArtifact, LoopRun
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


class LoopArtifactRepository(BaseRepository[LoopArtifact]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(LoopArtifact, session, org_id)

    async def list_by_loop(self, loop_id: uuid.UUID) -> list[LoopArtifact]:
        # ix_loop_artifacts_loop_variant_group과 동일 순서(variant_group, sort_order) — GET
        # 응답의 variant_group 그룹핑이 이미 정렬된 스캔 순서를 그대로 소비하도록.
        q = (
            select(LoopArtifact)
            .where(LoopArtifact.org_id == self.org_id, LoopArtifact.loop_id == loop_id)
            .order_by(LoopArtifact.variant_group.asc(), LoopArtifact.sort_order.asc())
        )
        return list((await self.session.execute(q)).scalars().all())

    async def list_pending_by_group(self, loop_id: uuid.UUID, variant_group: str) -> list[LoopArtifact]:
        q = select(LoopArtifact).where(
            LoopArtifact.org_id == self.org_id,
            LoopArtifact.loop_id == loop_id,
            LoopArtifact.variant_group == variant_group,
            LoopArtifact.decision == "pending",
        )
        return list((await self.session.execute(q)).scalars().all())

    async def count_pending(self, loop_id: uuid.UUID) -> int:
        q = select(LoopArtifact.id).where(
            LoopArtifact.org_id == self.org_id,
            LoopArtifact.loop_id == loop_id,
            LoopArtifact.decision == "pending",
        )
        return len((await self.session.execute(q)).scalars().all())

    async def distinct_variant_groups(self, loop_id: uuid.UUID) -> list[str]:
        q = (
            select(LoopArtifact.variant_group)
            .where(LoopArtifact.org_id == self.org_id, LoopArtifact.loop_id == loop_id)
            .distinct()
        )
        return list((await self.session.execute(q)).scalars().all())
