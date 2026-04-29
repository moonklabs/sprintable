import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team import TeamMember
from app.repositories.base import BaseRepository


class TeamMemberRepository(BaseRepository[TeamMember]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(TeamMember, session, org_id)

    async def list(self, **filters: Any) -> list[TeamMember]:
        q = select(TeamMember).where(self._org_filter())
        for attr, val in filters.items():
            q = q.where(getattr(TeamMember, attr) == val)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def deactivate(self, id: uuid.UUID) -> bool:
        """DELETE 대신 is_active=False soft deactivate."""
        member = await self.get(id)
        if member is None:
            return False
        await self.update(id, is_active=False)
        return True
