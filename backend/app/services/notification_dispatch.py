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
from app.models.webhook_config import WebhookConfig

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

        # 활성 webhook_configs가 있는 멤버 집합 — 웹훅 채널로 전달되므로 내장 알림 스킵
        webhook_member_ids: set[uuid.UUID] = set()
        try:
            wh_rows = await db.execute(
                select(WebhookConfig.member_id).where(
                    WebhookConfig.member_id.in_(enabled_member_ids),
                    WebhookConfig.is_active.is_(True),
                    WebhookConfig.member_id.isnot(None),
                )
            )
            webhook_member_ids = {row for row in wh_rows.scalars().all()}
        except Exception:
            logger.warning("dispatch_notification: webhook_configs lookup failed — no skip applied")

        # BUG-2 수정: user_id.isnot(None) 필터 제거 — agent는 user_id=NULL이므로 제외됐던 문제
        # type 및 project_id도 함께 조회
        members_result = await db.execute(
            select(TeamMember.id, TeamMember.user_id, TeamMember.type, TeamMember.project_id).where(
                TeamMember.id.in_(enabled_member_ids),
                TeamMember.org_id == org_id,
            )
        )
        members = list(members_result.all())

        # E-MEMBER-SSOT AC2-2: grant-only 휴먼(team_member 없음)은 org_member로 해소해
        # in-app Notification 누락(silent drop) 방지. org_member는 project 스코프가 없으므로
        # human Notification만 생성(Event는 project_id 필요 → skip). Notification은 user_id
        # 기반이고 FK가 없어 org_member.id 사용에 제약 없음.
        matched_ids = {m.id for m in members}
        missing_ids = [mid for mid in enabled_member_ids if mid not in matched_ids]
        if missing_ids:
            from types import SimpleNamespace

            from app.models.project import OrgMember
            om_result = await db.execute(
                select(OrgMember.id, OrgMember.user_id).where(
                    OrgMember.id.in_(missing_ids),
                    OrgMember.org_id == org_id,
                    OrgMember.deleted_at.is_(None),
                )
            )
            for om in om_result.all():
                members.append(
                    SimpleNamespace(id=om.id, user_id=om.user_id, type="human", project_id=None)
                )

        # 회귀 버그 fix: team_members는 0088 이후 projection VIEW라 멤버당 **프로젝트별 1행**(동일 id)을
        # 반환한다. dedup 없이 루프하면 멀티프로젝트 멤버에게 알림이 **프로젝트 수만큼 중복 생성**됨
        # (Story Assign 시 Inbox 알림 3개 증상 = 담당자가 3개 프로젝트 소속). member id로 dedup해
        # 멤버당 1 알림/이벤트만 생성. (view-cutover multi-row 트랩)
        _seen_member_ids: set = set()
        _deduped = []
        for _m in members:
            if _m.id in _seen_member_ids:
                continue
            _seen_member_ids.add(_m.id)
            _deduped.append(_m)
        members = _deduped

        inserted = False
        for member_row in members:
            if member_row.type == "agent":
                # 활성 웹훅 있는 에이전트 → 외부 채널로 전달되므로 내장 Event 스킵
                if member_row.id in webhook_member_ids:
                    logger.debug(
                        "dispatch_notification: skip agent %s — has active webhook", member_row.id
                    )
                    continue
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
                # human: Notification + Event 각각 독립 savepoint — 하나 실패해도 다른 쪽 롤백 방지
                try:
                    async with db.begin_nested():
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
                    inserted = True
                except Exception:
                    logger.warning("Notification INSERT failed member_id=%s event_type=%s", member_row.id, event_type)
                if member_row.project_id:
                    try:
                        async with db.begin_nested():
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
                    except Exception:
                        logger.warning("Event INSERT failed member_id=%s event_type=%s", member_row.id, event_type)

        if inserted:
            await db.flush()

    except Exception:
        # BUG-1 수정: 에러 삼킴 제거 → 스택 트레이스 로깅
        logger.exception("dispatch_notification failed org_id=%s event_type=%s", org_id, event_type)
