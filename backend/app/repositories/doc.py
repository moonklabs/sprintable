from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc
from app.repositories.base import BaseRepository


class DocRepository(BaseRepository[Doc]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Doc, session, org_id)

    async def list(self, limit: int = 500, **filters: Any) -> list[Doc]:  # type: ignore[override]
        q = select(Doc).where(self._org_filter(), Doc.deleted_at.is_(None))
        for attr, val in filters.items():
            q = q.where(getattr(Doc, attr) == val)
        q = q.order_by(Doc.sort_order).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def get_by_slug(self, project_id: uuid.UUID, slug: str) -> Doc | None:
        result = await self.session.execute(
            select(Doc).where(
                self._org_filter(),
                Doc.project_id == project_id,
                Doc.slug == slug,
                Doc.deleted_at.is_(None),
            ).limit(1)
        )
        return result.scalar_one_or_none()

    async def list_tree(self, project_id: uuid.UUID, parent_id: uuid.UUID | None = None, limit: int = 500) -> list[Doc]:
        """project 내 특정 parent 하위 docs 조회 (트리 1레벨)."""
        q = select(Doc).where(
            self._org_filter(),
            Doc.project_id == project_id,
            Doc.deleted_at.is_(None),
        )
        if parent_id is None:
            q = q.where(Doc.parent_id.is_(None))
        else:
            q = q.where(Doc.parent_id == parent_id)
        q = q.order_by(Doc.sort_order).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def search_by_tags(self, project_id: uuid.UUID, tags: list[str], limit: int = 500) -> list[Doc]:
        """tags 배열이 주어진 태그를 모두 포함하는 docs 조회 (@> 연산자)."""
        from sqlalchemy import cast
        from sqlalchemy.dialects.postgresql import ARRAY
        from sqlalchemy import Text

        q = select(Doc).where(
            self._org_filter(),
            Doc.project_id == project_id,
            Doc.deleted_at.is_(None),
            Doc.tags.contains(cast(tags, ARRAY(Text))),
        ).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())
