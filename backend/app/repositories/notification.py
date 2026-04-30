from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import InboxItem, Notification, NotificationSetting
from app.repositories.base import BaseRepository


class NotificationRepository(BaseRepository[Notification]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Notification, session, org_id)

    async def list(self, user_id: uuid.UUID, is_read: bool | None = None) -> list[Notification]:
        q = select(Notification).where(
            self._org_filter(),
            Notification.user_id == user_id,
        )
        if is_read is not None:
            q = q.where(Notification.is_read == is_read)
        q = q.order_by(Notification.created_at.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def count_unread(self, user_id: uuid.UUID) -> int:
        from sqlalchemy import func, select
        q = select(func.count()).select_from(Notification).where(
            self._org_filter(),
            Notification.user_id == user_id,
            Notification.is_read.is_(False),
        )
        result = await self.session.execute(q)
        return result.scalar_one()

    async def mark_all_read(self, user_id: uuid.UUID) -> None:
        await self.session.execute(
            update(Notification)
            .where(
                Notification.org_id == self.org_id,
                Notification.user_id == user_id,
                Notification.is_read.is_(False),
            )
            .values(is_read=True)
        )


class NotificationSettingRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_member(self, member_id: uuid.UUID) -> list[NotificationSetting]:
        result = await self.session.execute(
            select(NotificationSetting).where(NotificationSetting.member_id == member_id)
        )
        return list(result.scalars().all())

    async def upsert(
        self,
        org_id: uuid.UUID,
        member_id: uuid.UUID,
        channel: str,
        event_type: str,
        enabled: bool,
    ) -> NotificationSetting:
        existing = await self.session.execute(
            select(NotificationSetting).where(
                NotificationSetting.member_id == member_id,
                NotificationSetting.channel == channel,
                NotificationSetting.event_type == event_type,
            )
        )
        setting = existing.scalar_one_or_none()
        if setting is None:
            setting = NotificationSetting(
                org_id=org_id,
                member_id=member_id,
                channel=channel,
                event_type=event_type,
                enabled=enabled,
            )
            self.session.add(setting)
        else:
            setting.enabled = enabled
        await self.session.flush()
        await self.session.refresh(setting)
        return setting


class InboxRepository(BaseRepository[InboxItem]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(InboxItem, session, org_id)

    async def list(
        self, assignee_member_id: uuid.UUID, state: str | None = None
    ) -> list[InboxItem]:
        q = select(InboxItem).where(
            self._org_filter(),
            InboxItem.assignee_member_id == assignee_member_id,
        )
        if state is not None:
            q = q.where(InboxItem.state == state)
        q = q.order_by(InboxItem.waiting_since.desc())
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def list_incoming(self, assignee_member_id: uuid.UUID) -> list[InboxItem]:
        return await self.list(assignee_member_id, state="pending")

    async def resolve(
        self,
        id: uuid.UUID,
        resolved_by: uuid.UUID,
        resolved_option_id: uuid.UUID | None = None,
        resolved_note: str | None = None,
    ) -> InboxItem | None:
        return await self.update(
            id,
            state="resolved",
            resolved_by=resolved_by,
            resolved_option_id=resolved_option_id,
            resolved_note=resolved_note,
            resolved_at=datetime.now(timezone.utc),
        )

    async def dismiss(self, id: uuid.UUID) -> InboxItem | None:
        return await self.update(id, state="dismissed")
