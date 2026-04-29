import uuid
from typing import Any, Generic, TypeVar

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base

T = TypeVar("T", bound=Base)


class BaseRepository(Generic[T]):
    def __init__(self, model: type[T], session: AsyncSession, org_id: uuid.UUID) -> None:
        self.model = model
        self.session = session
        self.org_id = org_id

    def _org_filter(self) -> Any:
        return self.model.org_id == self.org_id  # type: ignore[attr-defined]

    async def get(self, id: uuid.UUID) -> T | None:
        result = await self.session.execute(
            select(self.model).where(self._org_filter(), self.model.id == id)  # type: ignore[attr-defined]
        )
        return result.scalar_one_or_none()

    async def list(self, **filters: Any) -> list[T]:
        q = select(self.model).where(self._org_filter())
        for attr, val in filters.items():
            q = q.where(getattr(self.model, attr) == val)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def create(self, **data: Any) -> T:
        obj = self.model(org_id=self.org_id, **data)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: Any) -> T | None:
        await self.session.execute(
            update(self.model)
            .where(self._org_filter(), self.model.id == id)  # type: ignore[attr-defined]
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
