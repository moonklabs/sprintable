"""E-EVENTBUS P3 S8/S27: 이벤트→알림 설정 필터 엔진.

notification_settings 조회 후 enabled인 member에게만 Notification INSERT.
설정 없으면 기본 enabled (opt-out 방식).

S27: agent type 멤버는 Notification 대신 events 테이블 INSERT (dispatched, pending).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.notification import Notification, NotificationSetting
from app.models.team import TeamMember

logger = logging.getLogger(__name__)


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
    """notification_settings 필터 후 enabled member에게 알림 발송.

    human 멤버: Notification 테이블 INSERT (in-app 알림)
    agent 멤버: events 테이블 INSERT (event_type=dispatched, status=pending)
               → poll_events / SSE 브릿지로 에이전트 수신

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

        # 설정 없으면 기본 enabled → enabled인 member만 필터
        enabled_member_ids = [
            mid for mid in target_member_ids
            if settings.get(mid, True)
        ]

        if not enabled_member_ids:
            return

        # BUG-2 수정: user_id.isnot(None) 필터 제거 — agent는 user_id=NULL이므로 제외됐던 문제
        # type 및 project_id도 함께 조회
        members_result = await db.execute(
            select(TeamMember.id, TeamMember.user_id, TeamMember.type, TeamMember.project_id).where(
                TeamMember.id.in_(enabled_member_ids),
                TeamMember.org_id == org_id,
            )
        )
        members = members_result.all()

        inserted = False
        for member_row in members:
            if member_row.type == "agent":
                # BUG-3 수정: agent → Notification 대신 events 테이블 INSERT
                if member_row.project_id:
                    event = Event(
                        project_id=member_row.project_id,
                        org_id=org_id,
                        event_type="dispatched",
                        source_entity_type=reference_type,
                        source_entity_id=reference_id,
                        sender_id=None,
                        recipient_id=member_row.id,
                        recipient_type="agent",
                        payload={"title": title, "body": body, "event_type": event_type},
                        status="pending",
                    )
                    db.add(event)
                    inserted = True
            elif member_row.user_id:
                # human: Notification INSERT (Inbox 호환) + Event INSERT (bell 패널용)
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
                if member_row.project_id:
                    event = Event(
                        project_id=member_row.project_id,
                        org_id=org_id,
                        event_type="dispatched",
                        source_entity_type=reference_type,
                        source_entity_id=reference_id,
                        sender_id=None,
                        recipient_id=member_row.id,
                        recipient_type="human",
                        payload={"title": title, "body": body, "event_type": event_type},
                        status="delivered",
                    )
                    db.add(event)
                inserted = True

        if inserted:
            await db.flush()

    except Exception:
        # BUG-1 수정: 에러 삼킴 제거 → 스택 트레이스 로깅
        logger.exception("dispatch_notification failed org_id=%s event_type=%s", org_id, event_type)
