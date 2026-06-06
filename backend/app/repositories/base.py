from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Generic, TypeVar

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base
from app.models.base import SoftDeleteMixin

T = TypeVar("T", bound=Base)

# cursor 페이지네이션이 안전한 단조 정렬 컬럼 화이트리스트.
# title/priority 등 비단조 컬럼은 cursor 중복으로 누락/중복을 유발하므로 제외한다.
_ORDERABLE_FIELDS = ("created_at", "updated_at")


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

    async def list(self, limit: int = 1000, **filters: Any) -> list[T]:
        q = select(self.model).where(self._org_filter())
        if issubclass(self.model, SoftDeleteMixin):
            q = q.where(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        for attr, val in filters.items():
            q = q.where(getattr(self.model, attr) == val)
        result = await self.session.execute(q.limit(limit))
        return list(result.scalars().all())

    def _orderable_fields(self) -> tuple[str, ...]:
        """cursor 페이지네이션을 허용할 정렬 컬럼. 서브클래스에서 확장 가능."""
        return _ORDERABLE_FIELDS

    async def list_paginated(
        self,
        *,
        limit: int | None = None,
        cursor: datetime | None = None,
        order_by: str = "created_at",
        **filters: Any,
    ) -> tuple[list[T], int]:
        """true cursor 페이지네이션 + 전체 카운트.

        - order_by: 단조 컬럼 화이트리스트(created_at/updated_at). 그 외는 created_at로 폴백.
        - cursor: 직전 페이지 마지막 row의 order_by 값(datetime). desc 페이지네이션(< cursor).
        - total: 페이지와 무관한 필터링 전체 개수(silent-truncation을 호출자가 인지하도록).
        - limit: None이면 기존 list()와 동일하게 1000 cap. 지정 시 그만큼만 반환(over-fetch는 호출자 책임).
        반환: (rows, total).
        """
        conds = [self._org_filter()]
        if issubclass(self.model, SoftDeleteMixin):
            conds.append(self.model.deleted_at.is_(None))  # type: ignore[attr-defined]
        for attr, val in filters.items():
            conds.append(getattr(self.model, attr) == val)

        # 전체 카운트(페이지네이션 무관) — 1000+ 잘림을 호출자가 알 수 있게 한다.
        count_result = await self.session.execute(
            select(func.count()).select_from(self.model).where(*conds)
        )
        total = int(count_result.scalar_one() or 0)

        if order_by not in self._orderable_fields():
            order_by = "created_at"
        order_col = getattr(self.model, order_by)

        q = select(self.model).where(*conds).order_by(
            order_col.desc(), self.model.id.desc()  # type: ignore[attr-defined]
        )

        if cursor is not None:
            q = q.where(order_col < cursor)

        q = q.limit(limit if limit is not None else 1000)
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

    async def create(self, **data: Any) -> T:
        obj = self.model(org_id=self.org_id, **data)
        self.session.add(obj)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def update(self, id: uuid.UUID, **data: Any) -> T | None:
        obj = await self.get(id)
        if obj is None:
            return None
        for key, value in data.items():
            setattr(obj, key, value)
        await self.session.flush()
        await self.session.refresh(obj)
        return obj

    async def delete(self, id: uuid.UUID) -> bool:
        obj = await self.get(id)
        if obj is None:
            return False
        await self.session.delete(obj)
        await self.session.flush()
        return True
