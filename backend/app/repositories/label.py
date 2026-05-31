import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.label import ItemLabel, Label
from app.repositories.base import BaseRepository


class LabelRepository(BaseRepository[Label]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Label, session, org_id)


class ItemLabelRepository(BaseRepository[ItemLabel]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(ItemLabel, session, org_id)

    async def list_by_item(self, item_id: uuid.UUID, item_type: str) -> list[ItemLabel]:
        result = await self.session.execute(
            select(ItemLabel).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.item_id == item_id,
                ItemLabel.item_type == item_type,
            )
        )
        return list(result.scalars().all())

    async def list_by_type(self, item_type: str) -> list[ItemLabel]:
        """item_id 생략 시 org 전체 item_type별 일괄 조회."""
        result = await self.session.execute(
            select(ItemLabel).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.item_type == item_type,
            )
        )
        return list(result.scalars().all())

    async def list_by_label(self, label_id: uuid.UUID) -> list[ItemLabel]:
        result = await self.session.execute(
            select(ItemLabel).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.label_id == label_id,
            )
        )
        return list(result.scalars().all())

    async def exists(self, label_id: uuid.UUID, item_id: uuid.UUID, item_type: str) -> bool:
        result = await self.session.execute(
            select(ItemLabel.id).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.label_id == label_id,
                ItemLabel.item_id == item_id,
                ItemLabel.item_type == item_type,
            )
        )
        return result.scalar_one_or_none() is not None

    async def delete_by_item(self, item_id: uuid.UUID, item_type: str) -> int:
        """항목 삭제 시 연관 item_label 행 cleanup — FK 없는 폴리모픽 구조 보상."""
        result = await self.session.execute(
            delete(ItemLabel).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.item_id == item_id,
                ItemLabel.item_type == item_type,
            )
        )
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]

    async def delete_by_label(self, label_id: uuid.UUID) -> int:
        """라벨 삭제 시 해당 라벨의 item_label 행 전량 cleanup."""
        result = await self.session.execute(
            delete(ItemLabel).where(
                ItemLabel.org_id == self.org_id,
                ItemLabel.label_id == label_id,
            )
        )
        await self.session.flush()
        return result.rowcount  # type: ignore[return-value]
