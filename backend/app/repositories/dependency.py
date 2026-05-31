import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dependency import ItemDependency
from app.repositories.base import BaseRepository


class DependencyRepository(BaseRepository[ItemDependency]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(ItemDependency, session, org_id)

    async def list_by_item(self, item_id: uuid.UUID, item_type: str) -> list[ItemDependency]:
        result = await self.session.execute(
            select(ItemDependency).where(
                ItemDependency.org_id == self.org_id,
                ItemDependency.item_type == item_type,
                (ItemDependency.from_id == item_id) | (ItemDependency.to_id == item_id),
            )
        )
        return list(result.scalars().all())

    async def delete_by_item(self, item_id: uuid.UUID, item_type: str) -> int:
        """항목 삭제 시 연관 의존 레코드 cleanup — FK 없는 폴리모픽 구조 보상."""
        result = await self.session.execute(
            delete(ItemDependency).where(
                ItemDependency.org_id == self.org_id,
                ItemDependency.item_type == item_type,
                (ItemDependency.from_id == item_id) | (ItemDependency.to_id == item_id),
            )
        )
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def exists(self, from_id: uuid.UUID, to_id: uuid.UUID, item_type: str) -> bool:
        result = await self.session.execute(
            select(ItemDependency.id).where(
                ItemDependency.org_id == self.org_id,
                ItemDependency.from_id == from_id,
                ItemDependency.to_id == to_id,
                ItemDependency.item_type == item_type,
            )
        )
        return result.scalar_one_or_none() is not None
