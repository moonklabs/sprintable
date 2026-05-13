"""E-EVENTBUS P3 S8: 이벤트→알림 설정 필터 엔진.

notification_settings 조회 후 enabled인 member에게만 Notification INSERT.
설정 없으면 기본 enabled (opt-out 방식).
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification, NotificationSetting
from app.models.team import TeamMember


async def dispatch_notification(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    event_type: str,
    target_member_ids: list[uuid.UUID],
    title: str,
    body: str | None = None,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
) -> None:
    """notification_settings 필터 후 enabled member에게 Notification INSERT.

    설정이 없는 member는 기본 enabled (opt-out).
    channel 기준: 'in_app'.
    """
    if not target_member_ids:
        return

    try:
        # notification_settings 조회 (해당 member + event_type + in_app)
        settings_result = await db.execute(
            select(NotificationSetting.member_id, NotificationSetting.enabled).where(
                NotificationSetting.org_id == org_id,
                NotificationSetting.member_id.in_(target_member_ids),
                NotificationSetting.event_type == event_type,
                NotificationSetting.channel == "in_app",
            )
        )
        settings = {row.member_id: row.enabled for row in settings_result.all()}

        # 설정 없으면 기본 enabled → 전체 대상 member_ids 중 enabled인 것만 필터
        enabled_member_ids = [
            mid for mid in target_member_ids
            if settings.get(mid, True)  # 설정 없으면 True (기본 enabled)
        ]

        if not enabled_member_ids:
            return

        # enabled member의 user_id 조회 (Notification.user_id는 users.id)
        members_result = await db.execute(
            select(TeamMember.id, TeamMember.user_id).where(
                TeamMember.id.in_(enabled_member_ids),
                TeamMember.org_id == org_id,
                TeamMember.user_id.isnot(None),
            )
        )
        members = members_result.all()

        for member_row in members:
            notification = Notification(
                org_id=org_id,
                user_id=member_row.user_id,
                type=event_type,
                title=title,
                body=body,
                is_read=False,
                reference_type=reference_type,
                reference_id=reference_id,
            )
            db.add(notification)

        if members:
            await db.flush()

    except Exception:
        pass
