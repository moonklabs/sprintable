import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.participation import Participation, ParticipationRole
from app.repositories.base import BaseRepository


class ParticipationRoleRepository(BaseRepository[ParticipationRole]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(ParticipationRole, session, org_id)

    async def get_default(self) -> ParticipationRole | None:
        result = await self.session.execute(
            select(ParticipationRole).where(
                ParticipationRole.org_id == self.org_id,
                ParticipationRole.is_default.is_(True),
            ).limit(1)
        )
        return result.scalar_one_or_none()


class ParticipationRepository(BaseRepository[Participation]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Participation, session, org_id)

    async def list_by_story(self, story_id: uuid.UUID) -> list[Participation]:
        result = await self.session.execute(
            select(Participation).where(
                Participation.org_id == self.org_id,
                Participation.story_id == story_id,
            )
        )
        return list(result.scalars().all())

    async def exists(self, story_id: uuid.UUID, member_id: uuid.UUID, role_id: uuid.UUID) -> bool:
        result = await self.session.execute(
            select(Participation.id).where(
                Participation.org_id == self.org_id,
                Participation.story_id == story_id,
                Participation.member_id == member_id,
                Participation.role_id == role_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def delete_by_story(self, story_id: uuid.UUID) -> int:
        """스토리 삭제 시 연관 participation 행 cleanup."""
        result = await self.session.execute(
            delete(Participation).where(
                Participation.org_id == self.org_id,
                Participation.story_id == story_id,
            )
        )
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]
