import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.repositories.base import BaseRepository
from app.schemas.story import STATUS_TRANSITIONS


class StoryRepository(BaseRepository[Story]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Story, session, org_id)

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

        # 순차 전이 검증
        current_idx = list(STORY_STATUSES).index(story.status)
        new_idx = list(STORY_STATUSES).index(new_status)
        if abs(new_idx - current_idx) > 1:
            raise ValueError(
                f"Non-sequential transition not allowed: {story.status} → {new_status}"
            )

        updated = await self.update(id, status=new_status)
        assert updated is not None
        return updated
