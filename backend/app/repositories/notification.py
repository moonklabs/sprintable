from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import InboxItem, Notification, NotificationSetting
from app.repositories.base import BaseRepository


class NotificationRepository(BaseRepository[Notification]):
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Notification, session, org_id)

    async def list(
        self,
        user_id: uuid.UUID,
        is_read: bool | None = None,
        limit: int = 200,
        before: datetime | None = None,
        before_id: uuid.UUID | None = None,
    ) -> list[Notification]:  # type: ignore[override]
        """story #2428: `before`(created_at) 단독 커서는 동률(같은 created_at) 시 페이지
        경계에서 행이 누락/중복될 수 있었다 — `before_id`가 같이 오면 (created_at, id) 복합
        비교로 전환한다(호출부 routers/notifications.py가 새 cursor 포맷 이관 시 항상 같이
        넘김). `before_id` 없이 `before`만 오는 옛 호출부는 없다 — 있었다면 그게 바로 이
        결함의 재현 경로였을 것.
        """
        q = select(Notification).where(
            self._org_filter(),
            Notification.user_id == user_id,
        )
        if is_read is not None:
            q = q.where(Notification.is_read == is_read)
        if before is not None and before_id is not None:
            q = q.where(tuple_(Notification.created_at, Notification.id) < tuple_(before, before_id))
        elif before is not None:
            q = q.where(Notification.created_at < before)
        q = q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit)
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

    async def mark_read(self, notification_id: uuid.UUID, user_id: uuid.UUID) -> Notification | None:
        """단일 알림 읽음 처리 — 소유자 본인(user_id) 것만. 없으면 None(404 용)."""
        await self.session.execute(
            update(Notification)
            .where(
                Notification.org_id == self.org_id,
                Notification.id == notification_id,
                Notification.user_id == user_id,
            )
            .values(is_read=True)
        )
        result = await self.session.execute(
            select(Notification).where(
                Notification.org_id == self.org_id,
                Notification.id == notification_id,
                Notification.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()


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
        self, assignee_member_id: uuid.UUID, project_id: uuid.UUID, state: str | None = None, limit: int = 200
    ) -> list[InboxItem]:  # type: ignore[override]
        # 카디르 QA HIGH1(PR#3352, 2026-08-22) — project_id 필터 부재로 member가 소속된 다른
        # 프로젝트의 inbox 항목까지 섞여 나왔다(Attention Queue 7개 cap을 무관 항목이 잠식).
        # InboxItem.project_id는 DB nullable=False(models/notification.py)+양쪽 생성 경로
        # (createInboxItemSchema·incomingInboxItemSchema, packages/shared/src/schemas/inbox.ts)
        # 모두 project_id를 필수(z.string().min(1))로 강제해 NULL 행이 존재할 수 없다(전체 쓰기
        # 경로 코드감사로 확認 — 이 환경엔 라이브 DB 조회 권한이 없어 실측은 이 감사로 갈음).
        # 그래서 project_id를 선택적 완화(NULL 포함) 없이 필수 파라미터+단순 동등비교로 건다.
        q = select(InboxItem).where(
            self._org_filter(),
            InboxItem.assignee_member_id == assignee_member_id,
            InboxItem.project_id == project_id,
        )
        if state is not None:
            q = q.where(InboxItem.state == state)
        q = q.order_by(InboxItem.waiting_since.desc()).limit(limit)
        result = await self.session.execute(q)
        return list(result.scalars().all())

    async def list_incoming(self, assignee_member_id: uuid.UUID, project_id: uuid.UUID) -> list[InboxItem]:
        return await self.list(assignee_member_id, project_id, state="pending")

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
