import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Sprint, Story
from app.repositories.base import BaseRepository


class SprintRepository(BaseRepository[Sprint]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Sprint, session, org_id)

    async def activate(self, id: uuid.UUID) -> Sprint:
        sprint = await self.get(id)
        if sprint is None:
            raise ValueError(f"Sprint {id} not found")
        if sprint.status != "planning":
            raise ValueError(f"Cannot activate sprint with status: {sprint.status}")

        result = await self.session.execute(
            select(Sprint).where(
                Sprint.org_id == self.org_id,
                Sprint.project_id == sprint.project_id,
                Sprint.status == "active",
            )
        )
        if result.scalar_one_or_none() is not None:
            raise ValueError("Active sprint already exists for this project")

        updated = await self.update(id, status="active")
        assert updated is not None
        return updated

    async def close(self, id: uuid.UUID) -> Sprint:
        sprint = await self.get(id)
        if sprint is None:
            raise ValueError(f"Sprint {id} not found")
        # E-DG S26: review 선택 단계 도입 → active 또는 review 에서 마감 가능(review→done).
        if sprint.status not in ("active", "review"):
            raise ValueError(f"Cannot close sprint with status: {sprint.status}")

        all_result = await self.session.execute(
            select(Story).where(
                Story.sprint_id == id,
                Story.deleted_at.is_(None),
            )
        )
        all_stories = all_result.scalars().all()
        done_stories = [s for s in all_stories if s.status == "done"]
        velocity = sum(s.story_points or 0 for s in done_stories)

        # E-OUTCOME-LOOP S3: velocity 계산 직후 채점 (비파괴 — 기존 close 로직 무변경)
        from app.services.outcome_scorer import score_sprint_outcome
        backlog_remaining = len([s for s in all_stories if s.status != "done"])
        total_points = sum(s.story_points or 0 for s in all_stories)
        scoring = score_sprint_outcome(
            sprint.metric_definition, velocity, backlog_remaining, total_points
        )
        extra = scoring if scoring is not None else {}

        updated = await self.update(id, status="closed", velocity=velocity, **extra)
        assert updated is not None
        return updated
