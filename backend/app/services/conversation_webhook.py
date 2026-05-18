"""S-A5: Conversation webhook delivery 서비스.

send_message BackgroundTask에서 호출.
webhook_configs.events에 'conversation.message_created' 포함 시 발송.
최대 3회 retry + backoff, 실패 시 failed 상태 + last_error 저장.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime, timezone

import httpx

from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
from app.models.webhook_config import WebhookConfig

logger = logging.getLogger(__name__)

_EVENT_TYPE = "conversation.message_created"
_MAX_RETRIES = 3
_BACKOFF_BASE = 1.0  # seconds


_DISCORD_URL_PATTERNS = ("discord.com/api/webhooks", "discordapp.com/api/webhooks")


def _is_discord_url(url: str) -> bool:
    return any(pat in url for pat in _DISCORD_URL_PATTERNS)


def _to_discord_payload(payload: dict) -> dict:
    """Sprintable webhook payload → Discord content 포맷 변환."""
    event_type = payload.get("event_type", "event")
    conversation_id = payload.get("conversation_id", "")
    sender_id = payload.get("sender_id") or ""
    lines = [f"[{event_type}]"]
    if conversation_id:
        lines.append(f"conversation_id: {conversation_id}")
    if sender_id:
        lines.append(f"sender_id: {sender_id}")
    return {"content": "\n".join(lines)}


def _sign_payload(secret: str, body: bytes) -> str:
    """HMAC-SHA256 서명 — X-Hub-Signature-256 헤더용."""
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


async def _attempt_delivery(url: str, secret: str | None, payload: dict) -> None:
    """단일 webhook HTTP POST 시도. 실패 시 예외 raise."""
    discord = _is_discord_url(url)
    delivery_payload = _to_discord_payload(payload) if discord else payload
    body = json.dumps(delivery_payload, default=str).encode()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if secret and not discord:
        headers["X-Hub-Signature-256"] = _sign_payload(secret, body)

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, content=body, headers=headers)
        resp.raise_for_status()


async def deliver_conversation_message_webhook(
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    thread_id: uuid.UUID | None,
    created_at: datetime,
    mentioned_ids: list[uuid.UUID] | None = None,
) -> None:
    """BackgroundTask 진입점.

    webhook_configs에서 conversation.message_created 이벤트 구독 중인
    활성 webhook을 조회하고 delivery attempt 기록 후 발송.
    """
    from app.core.database import async_session_factory
    from sqlalchemy import select

    async with async_session_factory() as db:
        try:
            wh_rows = (await db.execute(
                select(WebhookConfig).where(
                    WebhookConfig.org_id == org_id,
                    WebhookConfig.project_id == project_id,
                    WebhookConfig.is_active.is_(True),
                )
            )).scalars().all()

            # events가 NULL/빈 배열이면 전체 이벤트 구독으로 간주 (backwards compatible)
            target_webhooks = [
                wh for wh in wh_rows
                if not wh.events or _EVENT_TYPE in wh.events
            ]

            # AC2: member webhook 조회 — mentioned_ids 없으면 대화 참여자 전원(sender 제외) 대상
            member_ids_for_webhook: list[uuid.UUID] = list(mentioned_ids) if mentioned_ids else []
            if not member_ids_for_webhook:
                from app.models.conversation import ConversationParticipant
                participant_member_ids = (await db.execute(
                    select(ConversationParticipant.member_id).where(
                        ConversationParticipant.conversation_id == conversation_id,
                        *(
                            [ConversationParticipant.member_id != sender_id]
                            if sender_id else []
                        ),
                    )
                )).scalars().all()
                member_ids_for_webhook = list(participant_member_ids)

            if member_ids_for_webhook:
                extra_wh_rows = (await db.execute(
                    select(WebhookConfig).where(
                        WebhookConfig.org_id == org_id,
                        WebhookConfig.member_id.in_(member_ids_for_webhook),
                        WebhookConfig.is_active.is_(True),
                    )
                )).scalars().all()
                existing_ids = {wh.id for wh in target_webhooks}
                existing_urls = {wh.url for wh in target_webhooks}
                for wh in extra_wh_rows:
                    if wh.id not in existing_ids and wh.url not in existing_urls:
                        target_webhooks.append(wh)
                        existing_ids.add(wh.id)
                        existing_urls.add(wh.url)

            if not target_webhooks:
                return

            mentioned_id_strs = [str(m) for m in (mentioned_ids or [])]
            payload = {
                "event_type": _EVENT_TYPE,
                "message_id": str(message_id),
                "conversation_id": str(conversation_id),
                "sender_id": str(sender_id) if sender_id else None,
                "thread_id": str(thread_id) if thread_id else None,
                "created_at": created_at.isoformat(),
                "mentioned_ids": mentioned_id_strs,
            }

            for wh in target_webhooks:
                delivery = ConversationWebhookDelivery(
                    id=uuid.uuid4(),
                    message_id=message_id,
                    webhook_config_id=wh.id,
                    status="pending",
                    attempt_count=0,
                )
                db.add(delivery)
                await db.flush()
                delivery_id = delivery.id
                await db.commit()

                # 별도 세션에서 retry 루프
                asyncio.ensure_future(
                    _retry_deliver(delivery_id, wh.url, wh.secret, payload)
                )

        except Exception:
            logger.exception("conversation webhook schedule failed message_id=%s", message_id)


async def _retry_deliver(
    delivery_id: uuid.UUID,
    url: str,
    secret: str | None,
    payload: dict,
) -> None:
    """최대 3회 retry + exponential backoff."""
    from app.core.database import async_session_factory
    from sqlalchemy import select

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            await _attempt_delivery(url, secret, payload)

            async with async_session_factory() as db:
                delivery = (await db.execute(
                    select(ConversationWebhookDelivery).where(ConversationWebhookDelivery.id == delivery_id)
                )).scalar_one_or_none()
                if delivery:
                    delivery.status = "delivered"
                    delivery.attempt_count = attempt
                    delivery.updated_at = datetime.now(timezone.utc)
                    await db.commit()
            return

        except Exception as exc:
            error_msg = str(exc)[:500]
            if attempt < _MAX_RETRIES:
                backoff = _BACKOFF_BASE * (2 ** (attempt - 1))
                logger.warning(
                    "webhook delivery attempt %d/%d failed delivery_id=%s: %s — retry in %.1fs",
                    attempt, _MAX_RETRIES, delivery_id, error_msg, backoff,
                )
                await asyncio.sleep(backoff)
            else:
                logger.error(
                    "webhook delivery failed permanently delivery_id=%s: %s",
                    delivery_id, error_msg,
                )
                async with async_session_factory() as db:
                    delivery = (await db.execute(
                        select(ConversationWebhookDelivery).where(ConversationWebhookDelivery.id == delivery_id)
                    )).scalar_one_or_none()
                    if delivery:
                        delivery.status = "failed"
                        delivery.attempt_count = attempt
                        delivery.last_error = error_msg
                        delivery.updated_at = datetime.now(timezone.utc)
                        await db.commit()
