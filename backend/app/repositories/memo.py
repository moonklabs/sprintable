from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc
from app.models.memo import Memo, MemoDocLink, MemoEntityLink, MemoRead, MemoReply
from app.models.pm import Epic, Story, Task
from app.repositories.base import BaseRepository
from app.schemas.memo import MemoEntityLinkCreate, MemoEntityLinkResponse


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

    async def create_entity_links(
        self, memo_id: uuid.UUID, embeds: list[MemoEntityLinkCreate]
    ) -> None:
        for embed in embeds:
            self.session.add(MemoEntityLink(
                memo_id=memo_id,
                entity_type=embed.entity_type,
                entity_id=embed.entity_id,
                position=embed.position,
            ))
        await self.session.flush()

    async def get_entity_links_resolved(
        self, memo_id: uuid.UUID
    ) -> list[MemoEntityLinkResponse]:
        result = await self.session.execute(
            select(MemoEntityLink)
            .where(MemoEntityLink.memo_id == memo_id)
            .order_by(MemoEntityLink.position)
        )
        links = list(result.scalars().all())
        if not links:
            return []

        # Batch-resolve titles/statuses per entity_type
        by_type: dict[str, list[uuid.UUID]] = {}
        for lnk in links:
            by_type.setdefault(lnk.entity_type, []).append(lnk.entity_id)

        resolved: dict[uuid.UUID, tuple[str | None, str | None]] = {}

        if "story" in by_type:
            rows = await self.session.execute(
                select(Story.id, Story.title, Story.status).where(Story.id.in_(by_type["story"]))
            )
            for rid, title, status in rows:
                resolved[rid] = (title, status)

        if "doc" in by_type:
            rows = await self.session.execute(
                select(Doc.id, Doc.title).where(Doc.id.in_(by_type["doc"]))
            )
            for rid, title in rows:
                resolved[rid] = (title, None)

        if "epic" in by_type:
            rows = await self.session.execute(
                select(Epic.id, Epic.title, Epic.status).where(Epic.id.in_(by_type["epic"]))
            )
            for rid, title, status in rows:
                resolved[rid] = (title, status)

        if "task" in by_type:
            rows = await self.session.execute(
                select(Task.id, Task.title, Task.status).where(Task.id.in_(by_type["task"]))
            )
            for rid, title, status in rows:
                resolved[rid] = (title, status)

        out = []
        for lnk in links:
            title, status = resolved.get(lnk.entity_id, (None, None))
            out.append(MemoEntityLinkResponse(
                id=lnk.id,
                memo_id=lnk.memo_id,
                entity_type=lnk.entity_type,
                entity_id=lnk.entity_id,
                position=lnk.position,
                created_at=lnk.created_at,
                title=title,
                status=status,
            ))
        return out

    async def get_entity_link_count(self, memo_id: uuid.UUID) -> int:
        from sqlalchemy import func
        result = await self.session.execute(
            select(func.count()).select_from(MemoEntityLink).where(MemoEntityLink.memo_id == memo_id)
        )
        return result.scalar_one()


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
