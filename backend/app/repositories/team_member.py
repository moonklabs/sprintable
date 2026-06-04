import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team import TeamMember
from app.repositories.base import BaseRepository


class TeamMemberRepository(BaseRepository[TeamMember]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(TeamMember, session, org_id)

    async def list(self, limit: int = 1000, **filters: Any) -> list[TeamMember]:  # type: ignore[override]
        q = select(TeamMember).where(self._org_filter())
        for attr, val in filters.items():
            q = q.where(getattr(TeamMember, attr) == val)
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())

    async def deactivate(self, id: uuid.UUID) -> bool:
        """DELETE 대신 is_active=False soft deactivate."""
        member = await self.get(id)
        if member is None:
            return False
        await self.update(id, is_active=False)
        # AC3-4 2-1 dual-write: 뷰가 is_active를 members서 읽으므로 동시 반영(에이전트 members.id=tm.id;
        # 휴먼은 members.id=org_member.id라 미매치=0건 무해, 휴먼 비활성은 org_members 경로에서 처리).
        await self.session.execute(
            text("UPDATE members SET is_active = false WHERE id = :id"), {"id": str(id)}
        )
        return True
