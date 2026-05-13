from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.repositories.base import BaseRepository
from app.schemas.story import STATUS_TRANSITIONS


class StoryRepository(BaseRepository[Story]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Story, session, org_id)

    async def list_backlog(self, project_id: uuid.UUID, limit: int = 1000) -> list[Story]:
        """sprint 미배정 + 삭제되지 않은 스토리만 서버사이드 필터."""
        result = await self.session.execute(
            select(Story).where(
                self._org_filter(),
                Story.project_id == project_id,
                Story.sprint_id.is_(None),
                Story.deleted_at.is_(None),
            ).limit(limit)
        )
        return list(result.scalars().all())

    async def transition_status(self, id: uuid.UUID) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")
        next_status = STATUS_TRANSITIONS.get(story.status)
        if next_status is None:
            raise ValueError(f"No forward transition from status: {story.status}")
        updated = await self.update(id, status=next_status)
        assert updated is not None
        return updated

    async def set_status(self, id: uuid.UUID, new_status: str) -> Story:
        story = await self.get(id)
        if story is None:
            raise ValueError(f"Story {id} not found")

        from app.schemas.story import STORY_STATUSES
        if new_status not in STORY_STATUSES:
            raise ValueError(f"Invalid status: {new_status}")

        if new_status == story.status:
            return story

        current_idx = list(STORY_STATUSES).index(story.status)
        new_idx = list(STORY_STATUSES).index(new_status)
        if new_idx != current_idx + 1:
            raise ValueError(
                f"Non-sequential transition not allowed: {story.status} → {new_status}"
            )

        updated = await self.update(id, status=new_status)
        assert updated is not None
        return updated
