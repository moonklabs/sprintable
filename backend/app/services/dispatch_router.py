"""S-A6: Dispatch Event 경량 알림 라우팅 어댑터.

dispatch event(story_assigned 등 lifecycle event)에 대해
NotificationPreference 기반 채널 결정 후 전달.
conversation_messages row를 생성하지 않음 (AC5).

S-COMM-02: webhook_url 없는 에이전트 → SSE inbox 기본 수신.
           webhook_url 있는 에이전트 → HTTP POST + HMAC + retry 3회 + SSE fallback.
"""
from __future__ import annotations

import asyncio
import json as _json
import logging
import uuid

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember

logger = logging.getLogger(__name__)

# agent가 받을 때 mute를 무시하는 event_type 패턴 (AC3)
_AGENT_MANDATORY_TYPES = {"story_assigned", "story_reassigned", "task_assigned"}

_WEBHOOK_MAX_RETRIES = 3
_WEBHOOK_BACKOFF_BASE = 1.0  # seconds: 1s, 2s, 4s


async def _post_with_retry(
    url: str,
    payload: dict,
    secret: str | None,
    member_id: str,
) -> bool:
    """HMAC 서명 + exponential backoff webhook POST (AC3/AC5).
    성공 시 True, 전량 실패 시 False (호출자가 SSE fallback 담당 — AC4).
    """
    from app.services.webhook_dispatch import _build_signature_headers

    body = _json.dumps(payload)
    headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}

    for attempt in range(_WEBHOOK_MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, content=body, headers=headers)
                if resp.status_code < 500:
                    return True  # 2xx / 4xx — 재시도 무의미한 응답 포함
        except Exception:
            logger.warning(
                "webhook POST attempt %d/%d failed member=%s",
                attempt + 1, _WEBHOOK_MAX_RETRIES, member_id, exc_info=True,
            )
        if attempt < _WEBHOOK_MAX_RETRIES - 1:
            await asyncio.sleep(_WEBHOOK_BACKOFF_BASE * (2 ** attempt))

    logger.warning("webhook POST all retries exhausted member=%s url=%s — SSE fallback", member_id, url)
    return False

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

    # webhook_configs 조회 — 활성 웹훅이 있으면 channel 설정에 관계없이 외부로 전달
    active_wh = (await db.execute(
        select(WebhookConfig).where(
            WebhookConfig.member_id == recipient_id,
            WebhookConfig.is_active.is_(True),
        )
    )).scalars().first()

    if active_wh and channel == "sse":
        # AC2: webhook URL로 POST — HMAC 서명 + exponential backoff retry
        is_discord_url = (
            "discord.com/api/webhooks" in active_wh.url
            or "discordapp.com/api/webhooks" in active_wh.url
        )
        ext_payload = (
            {"content": f"[{event.event_type}] {payload.get('payload', {}).get('title', event.event_type)}"}
            if is_discord_url
            else payload
        )
        # Discord URL은 secret 미적용 (Discord 자체 인증 방식 사용)
        secret = None if is_discord_url else active_wh.secret
        success = await _post_with_retry(active_wh.url, ext_payload, secret, str(recipient_id))
        if not success:
            # AC4: 재시도 전량 실패 → SSE inbox fallback (이벤트 유실 방지)
            _push_to_agent(str(recipient_id), payload)
    elif channel == "sse":
        # AC1: webhook 없는 에이전트 → SSE stream 기본 수신
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
            success = await _post_with_retry(wh.url, discord_payload, None if is_discord_url else wh.secret, str(recipient_id))
            if not success:
                _push_to_agent(str(recipient_id), payload)
    else:
        # in_app, telegram 등 — 현재 in_app은 SSE로 처리
        _push_to_agent(str(recipient_id), payload)

    # S-C2: dispatch_triggered — agent recipient인 경우 기록 (AC2, AC6)
    if recipient_type == "agent":
        try:
            # prod 커넥션 누수 근본fix(2026-07-08, 까심 QA #1970 후속 — 동일 취약 패턴):
            # 참조 미보관 ensure_future는 GC가 record_activity_bg()의
            # `async with async_session_factory()` 도중 태스크를 조기수거할 수 있다.
            from app.services.activity_log import record_activity_bg
            from app.services.pg_pubsub import fire_and_forget
            fire_and_forget(record_activity_bg(
                org_id=event.org_id,
                action="dispatch_triggered",
                actor_id=recipient_id,
                actor_type="agent",
                project_id=getattr(event, "project_id", None),
                entity_type="event",
                entity_id=event_id,
                context={"event_type": event.event_type, "channel": channel},
            ))
        except Exception:
            logger.warning("dispatch record_activity_bg setup failed event_id=%s", event_id, exc_info=True)
