import uuid
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.meeting import Meeting


class MeetingRepository:
    """project_id 기반 스코핑 — org_id 없으므로 BaseRepository 미상속."""

    def __init__(self, session: AsyncSession, project_id: uuid.UUID) -> None:
        self.session = session
        self.project_id = project_id

    def _project_filter(self) -> Any:
        return Meeting.project_id == self.project_id

    async def get(self, id: uuid.UUID) -> Meeting | None:
        result = await self.session.execute(
            select(Meeting).where(
                self._project_filter(),
                Meeting.id == id,
                Meeting.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list(self, **filters: Any) -> list[Meeting]:
        q = select(Meeting).where(
            self._project_filter(),
            Meeting.deleted_at.is_(None),
        )
        for attr, val in filters.items():
            q = q.where(getattr(Meeting, attr) == val)
        q = q.order_by(Meeting.date.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def create(self, **data: Any) -> Meeting:
        obj = Meeting(project_id=self.project_id, **data)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: Any) -> Meeting | None:
        await self.session.execute(
            update(Meeting)
            .where(self._project_filter(), Meeting.id == id)
            .values(**data)
        )
        return await self.get(id)

    async def delete(self, id: uuid.UUID) -> bool:
        obj = await self.get(id)
        if obj is None:
            return False
        await self.session.delete(obj)
        await self.session.flush()
        return True
