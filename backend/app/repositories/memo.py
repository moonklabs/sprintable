from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.memo import Memo, MemoDocLink, MemoRead, MemoReply
from app.repositories.base import BaseRepository


class MemoRepository(BaseRepository[Memo]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Memo, session, org_id)

    async def list(self, **filters: Any) -> list[Memo]:
        q = select(Memo).where(self._org_filter(), Memo.deleted_at.is_(None))
        if "project_id" in filters:
            q = q.where(Memo.project_id == filters["project_id"])
        if "assigned_to" in filters:
            q = q.where(Memo.assigned_to == filters["assigned_to"])
        if "status" in filters:
            q = q.where(Memo.status == filters["status"])
        if "q" in filters and filters["q"]:
            search = f"%{filters['q']}%"
            q = q.where(or_(Memo.title.ilike(search), Memo.content.ilike(search)))
        q = q.order_by(Memo.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def soft_delete(self, id: uuid.UUID) -> bool:
        memo = await self.get(id)
        if memo is None:
            return False
        from sqlalchemy import update
        await self.session.execute(
            update(Memo).where(Memo.id == id).values(deleted_at=datetime.now(timezone.utc))
        )
        return True

    async def resolve(self, id: uuid.UUID, resolved_by: uuid.UUID) -> Memo | None:
        return await self.update(id, status="resolved", resolved_by=resolved_by,
                                 resolved_at=datetime.now(timezone.utc))

    async def archive(self, id: uuid.UUID) -> Memo | None:
        return await self.update(id, archived_at=datetime.now(timezone.utc))

    async def mark_read(self, id: uuid.UUID, team_member_id: uuid.UUID) -> None:
        existing = await self.session.execute(
            select(MemoRead).where(MemoRead.memo_id == id, MemoRead.team_member_id == team_member_id)
        )
        if existing.scalar_one_or_none() is None:
            self.session.add(MemoRead(memo_id=id, team_member_id=team_member_id))
            await self.session.flush()

    async def get_doc_links(self, id: uuid.UUID) -> list[MemoDocLink]:
        result = await self.session.execute(
            select(MemoDocLink).where(MemoDocLink.memo_id == id)
        )
        return list(result.scalars().all())


class MemoReplyRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, **data: Any) -> MemoReply:
        reply = MemoReply(**data)
        self.session.add(reply)
        await self.session.flush()
        await self.session.refresh(reply)
        return reply

    async def list_by_memo(self, memo_id: uuid.UUID) -> list[MemoReply]:
        result = await self.session.execute(
            select(MemoReply).where(MemoReply.memo_id == memo_id).order_by(MemoReply.created_at)
        )
        return list(result.scalars().all())
