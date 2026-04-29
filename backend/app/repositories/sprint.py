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
        if sprint.status != "active":
            raise ValueError(f"Cannot close sprint with status: {sprint.status}")

        result = await self.session.execute(
            select(Story).where(
                Story.sprint_id == id,
                Story.status == "done",
                Story.deleted_at.is_(None),
            )
        )
        done_stories = result.scalars().all()
        velocity = sum(s.story_points or 0 for s in done_stories)

        updated = await self.update(id, status="closed", velocity=velocity)
        assert updated is not None
        return updated
