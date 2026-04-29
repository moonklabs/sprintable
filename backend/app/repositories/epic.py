import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Epic, Story
from app.repositories.base import BaseRepository
from app.schemas.epic import EpicProgressResponse


class EpicRepository(BaseRepository[Epic]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Epic, session, org_id)

    async def get_progress(self, id: uuid.UUID) -> EpicProgressResponse:
        result = await self.session.execute(
            select(
                func.count(Story.id).label("total_stories"),
                func.sum(Story.story_points).label("total_sp"),
                func.count(Story.id).filter(Story.status == "done").label("done_stories"),
                func.sum(Story.story_points).filter(Story.status == "done").label("done_sp"),
            ).where(
                Story.epic_id == id,
                Story.deleted_at.is_(None),
            )
        )
        row = result.one()
        total_stories = row.total_stories or 0
        done_stories = row.done_stories or 0
        total_sp = int(row.total_sp or 0)
        done_sp = int(row.done_sp or 0)
        completion_pct = round((done_sp / total_sp) * 100) if total_sp > 0 else 0

        return EpicProgressResponse(
            epic_id=id,
            total_stories=total_stories,
            done_stories=done_stories,
            total_sp=total_sp,
            done_sp=done_sp,
            completion_pct=completion_pct,
        )
