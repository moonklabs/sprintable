"""S-A6: Dispatch Event 경량 알림 라우팅 어댑터.

dispatch event(story_assigned 등 lifecycle event)에 대해
NotificationPreference 기반 채널 결정 후 전달.
conversation_messages row를 생성하지 않음 (AC5).
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember

logger = logging.getLogger(__name__)

# agent가 받을 때 mute를 무시하는 event_type 패턴 (AC3)
_AGENT_MANDATORY_TYPES = {"story_assigned", "story_reassigned", "task_assigned"}

_VALID_CHANNELS = {"sse", "discord", "telegram", "in_app"}


async def route_dispatch_event(
    event_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """dispatch event → channel preference 기반 전달.

    SSE(agent): _push_to_agent 호출.
    Discord: webhook_configs discord endpoint 조회 후 HTTP POST.
    mute: 전달 skip. agent+assigned는 mute 무시.
    """
    from app.models.webhook_config import WebhookConfig
    from app.routers.events import _event_to_payload, _push_to_agent

    event = (await db.execute(
        select(Event).where(Event.id == event_id)
    )).scalar_one_or_none()
    if event is None:
        logger.warning("route_dispatch_event: event %s not found", event_id)
        return

    recipient_id = event.recipient_id
    recipient_type = event.recipient_type

    # preference 조회 — global scope 우선, 없으면 기본값
    pref = (await db.execute(
        select(NotificationPreference).where(
            NotificationPreference.member_id == recipient_id,
            NotificationPreference.scope_type == "global",
            NotificationPreference.scope_id.is_(None),
        )
    )).scalars().first()

    channel = pref.channel if pref else ("sse" if recipient_type == "agent" else "in_app")
    level = pref.level if pref else "all"

    # AC3: agent + assigned event → mute 무시, 강제 delivery (exact match)
    is_mandatory = (
        recipient_type == "agent"
        and event.event_type in _AGENT_MANDATORY_TYPES
    )
    if level == "mute" and not is_mandatory:
        logger.debug("route_dispatch_event: mute skip event_id=%s recipient=%s", event_id, recipient_id)
        return

    payload = _event_to_payload(event)

    if channel == "sse":
        _push_to_agent(str(recipient_id), payload)

    elif channel == "discord":
        import httpx
        wh = (await db.execute(
            select(WebhookConfig).where(
                WebhookConfig.member_id == recipient_id,
                WebhookConfig.channel == "discord",
                WebhookConfig.is_active.is_(True),
            )
        )).scalars().first()

        if wh is None:
            # AC11 fallback: discord endpoint 미설정 → sse fallback
            logger.info(
                "route_dispatch_event: discord endpoint missing for %s — sse fallback", recipient_id
            )
            _push_to_agent(str(recipient_id), payload)
        else:
            is_discord_url = (
                "discord.com/api/webhooks" in wh.url
                or "discordapp.com/api/webhooks" in wh.url
            )
            discord_payload = (
                {"content": f"[{event.event_type}] {payload.get('payload', {}).get('title', event.event_type)}"}
                if is_discord_url
                else payload
            )
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(wh.url, json=discord_payload)
            except Exception:
                logger.warning(
                    "route_dispatch_event: discord POST failed member=%s", recipient_id, exc_info=True
                )
    else:
        # in_app, telegram 등 — 현재 in_app은 SSE로 처리
        _push_to_agent(str(recipient_id), payload)
