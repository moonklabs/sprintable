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
    """Sprintable webhook payload → Discord content 포맷 변환 (_fire_webhook 스타일)."""
    content_text = (payload.get("content") or "")[:500]
    conversation_id = payload.get("conversation_id", "")
    thread_id = payload.get("thread_id") or ""

    discord_content = f"📩 **새 메시지**"
    if content_text:
        discord_content += f"\n{content_text}"
    if conversation_id:
        discord_content += f"\n\nconversation_id: {conversation_id}"
    if thread_id:
        discord_content += f"\nmessage_id: {thread_id}"

    result: dict = {"content": discord_content}
    app_url = __import__("os").environ.get("NEXT_PUBLIC_APP_URL", "")
    if app_url and conversation_id:
        result["embeds"] = [{"title": "대화 보기", "url": f"{app_url}/conversations/{conversation_id}"}]
    return result


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


async def deliver_injected_event_webhook(
    *,
    org_id: uuid.UUID,
    recipient_id: uuid.UUID,
    content: str,
    event_type: str,
    source_entity_type: str | None = None,
    source_entity_id: uuid.UUID | None = None,
    hypothesis_anchor: dict | None = None,
) -> None:
    """1f01c1ad: INJECTABLE 이벤트(dispatched/story_assigned 등)를 수신자 member webhook으로 전달.

    배경(선생님 제보 2026-06-09): ``conversation.message_created``는
    :func:`deliver_conversation_message_webhook`로 수신자 member webhook(=CC 릴레이가 소비하는
    Discord/fakechat 경로)에 주입되지만, ``/api/v2/dispatch``·story 배정이 만드는
    ``dispatched``/``story_assigned`` 이벤트는 ``wake_agent`` (SSE)로만 통지됐다. CC 세션은 SSE
    dial-out이 아니라 member webhook으로 구동되므로, 이 이벤트들은 CC 세션에 영영 도달하지 못했다
    (문서 dispatch → CC 주입 0). 이 함수가 그 갭을 메워 INJECTABLE 이벤트도 conversation message와
    **동일한 webhook 경로**로 CC 세션에 주입한다.

    dup 0: webhook은 이 호출에서 수신자 webhook당 정확히 1회 발송된다. 기존 ``wake_agent`` (SSE)는
    별개 채널이고, conversation message가 이미 SSE+webhook 양쪽으로 전달되는 것과 동형이다
    (채널별 1회 — acked_seq seq-dedup은 SSE 채널 내부 전용이라 본 webhook 채널과 무관). conversation
    message가 아니므로 ``ConversationWebhookDelivery`` 추적 행은 만들지 않는다(그 ``message_id``는
    ``conversation_messages``를 가리키는 FK라 dispatched 이벤트에 부적합).
    """
    if not content or not content.strip():
        return

    from app.core.database import async_session_factory
    from sqlalchemy import select

    async with async_session_factory() as db:
        try:
            wh_rows = (await db.execute(
                select(WebhookConfig).where(
                    WebhookConfig.org_id == org_id,
                    WebhookConfig.member_id == recipient_id,
                    WebhookConfig.is_active.is_(True),
                )
            )).scalars().all()
        except Exception:
            logger.exception(
                "injected-event webhook lookup failed recipient=%s event=%s",
                recipient_id, event_type,
            )
            return

    # events가 NULL/빈 배열이면 전체 이벤트 구독으로 간주 (deliver_conversation_message_webhook 동형)
    targets = [wh for wh in wh_rows if not wh.events or event_type in wh.events]
    if not targets:
        return

    payload = {
        "event_type": event_type,
        "content": content,
        "source_entity_type": source_entity_type,
        "source_entity_id": str(source_entity_id) if source_entity_id else None,
        # E1-S6 L4: 대표 가설 anchor(additive·null default — 구 소비자 호환).
        "hypothesis_anchor": hypothesis_anchor,
    }

    seen_urls: set[str] = set()
    for wh in targets:
        if wh.url in seen_urls:  # 같은 endpoint 중복 발송 방지 (dup 0)
            continue
        seen_urls.add(wh.url)
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                await _attempt_delivery(wh.url, wh.secret, payload)
                break
            except Exception as exc:
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_BASE * (2 ** (attempt - 1)))
                else:
                    logger.warning(
                        "injected-event webhook delivery failed recipient=%s event=%s url=%s: %s",
                        recipient_id, event_type, wh.url, str(exc)[:200],
                    )


async def deliver_conversation_message_webhook(
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    sender_id: uuid.UUID | None,
    thread_id: uuid.UUID | None,
    created_at: datetime,
    mentioned_ids: list[uuid.UUID] | None = None,
    content: str | None = None,
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

            # 웹훅 없는 멤버 → 내장 /chats 경로로 fallback (conversations router에서 처리)
            webhook_covered_ids: set[uuid.UUID] = {
                wh.member_id for wh in target_webhooks if wh.member_id is not None
            }
            fallback_ids = [mid for mid in member_ids_for_webhook if mid not in webhook_covered_ids]
            if fallback_ids:
                logger.debug(
                    "conversation webhook: %d member(s) without webhook — in-app fallback applies message_id=%s",
                    len(fallback_ids),
                    message_id,
                )

            if not target_webhooks:
                return

            mentioned_id_strs = [str(m) for m in (mentioned_ids or [])]
            # d0bca260: conversation_title + sender_name 도출(additive 컨텍스트).
            from app.models.conversation import Conversation
            conv_title = (await db.execute(
                select(Conversation.title).where(Conversation.id == conversation_id)
            )).scalar_one_or_none()
            sender_name = None
            if sender_id is not None:
                from app.models.team import TeamMember
                sender_name = (await db.execute(
                    select(TeamMember.name).where(TeamMember.id == sender_id)
                )).scalar_one_or_none()

            # R2 S1(9d130c01): 첨부 내용을 에이전트-facing content 에 주입(균일·런타임 무변경).
            # 기존 authorize 된 전달 경로(이 webhook=참가자 대상)에 올라타고, fetch 는 이 대화에
            # 스코프된 객체만(IDOR 차단). best-effort — 조회/추출 실패는 전달에 무영향.
            # MED(QA RC): 주입 없으면 원 content 그대로 보존(None→"" 변환 금지 — 기존 거동 무변경).
            effective_content = content
            try:
                from app.models.conversation import ConversationMessage
                _atts = (await db.execute(
                    select(ConversationMessage.attachments).where(
                        ConversationMessage.id == message_id
                    )
                )).scalar_one_or_none()
                if _atts:
                    from app.services.attachment_context import build_attachment_context
                    _ctx = await build_attachment_context(
                        _atts, project_id=project_id, conversation_id=conversation_id
                    )
                    if _ctx:
                        _base = content or ""
                        effective_content = (_base + _ctx) if _base else _ctx.lstrip()
                        logger.info(
                            "attachment_context injected message_id=%s attachment_count=%d",
                            message_id, len(_atts),
                        )
            except Exception:
                logger.warning(
                    "attachment_context injection failed message_id=%s", message_id, exc_info=True
                )

            payload = {
                "event_type": _EVENT_TYPE,
                "message_id": str(message_id),
                "conversation_id": str(conversation_id),
                "sender_id": str(sender_id) if sender_id else None,
                "thread_id": str(thread_id) if thread_id else None,
                "created_at": created_at.isoformat(),
                "mentioned_ids": mentioned_id_strs,
                "content": effective_content,
                # d0bca260: BYOA 어댑터 컨텍스트(additive top-level).
                "project_id": str(project_id),
                "org_id": str(org_id),
                "conversation_title": conv_title,
                "sender_name": sender_name,
            }

            for wh in target_webhooks:
                delivery = ConversationWebhookDelivery(
                    id=uuid.uuid4(),
                    message_id=message_id,
                    webhook_config_id=wh.id,
                    status="event_created",  # 4단계: event_created → webhook_posted → gateway_accepted → agent_replied
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


async def _update_delivery_status(
    delivery_id: uuid.UUID,
    status: str,
    attempt_count: int | None = None,
    last_error: str | None = None,
) -> None:
    """delivery 상태 업데이트 — 별도 세션."""
    from app.core.database import async_session_factory
    from sqlalchemy import select

    async with async_session_factory() as db:
        delivery = (await db.execute(
            select(ConversationWebhookDelivery).where(ConversationWebhookDelivery.id == delivery_id)
        )).scalar_one_or_none()
        if delivery:
            delivery.status = status
            delivery.updated_at = datetime.now(timezone.utc)
            if attempt_count is not None:
                delivery.attempt_count = attempt_count
            if last_error is not None:
                delivery.last_error = last_error
            await db.commit()


async def mark_agent_replied(conversation_id: uuid.UUID) -> None:
    """에이전트 답신 시 해당 conversation의 최근 gateway_accepted delivery → agent_replied."""
    from app.core.database import async_session_factory
    from app.models.conversation import ConversationMessage  # ConversationMessage는 conversation.py에 정의됨
    from sqlalchemy import select

    async with async_session_factory() as db:
        # conversation의 최근 메시지 id 목록 조회 후 delivery 검색
        msg_ids = (await db.execute(
            select(ConversationMessage.id)
            .where(ConversationMessage.conversation_id == conversation_id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(20)
        )).scalars().all()

        if not msg_ids:
            return

        delivery = (await db.execute(
            select(ConversationWebhookDelivery)
            .where(
                ConversationWebhookDelivery.message_id.in_(msg_ids),
                ConversationWebhookDelivery.status == "gateway_accepted",
            )
            .order_by(ConversationWebhookDelivery.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()

        if delivery:
            delivery.status = "agent_replied"
            delivery.updated_at = datetime.now(timezone.utc)
            await db.commit()


async def _retry_deliver(
    delivery_id: uuid.UUID,
    url: str,
    secret: str | None,
    payload: dict,
) -> None:
    """최대 3회 retry + exponential backoff.

    상태 전이: event_created → webhook_posted → gateway_accepted (성공) / failed (영구실패)
    """
    # 첫 attempt 전: webhook_posted
    await _update_delivery_status(delivery_id, "webhook_posted")

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            await _attempt_delivery(url, secret, payload)
            await _update_delivery_status(delivery_id, "gateway_accepted", attempt_count=attempt)
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
                await _update_delivery_status(
                    delivery_id, "failed", attempt_count=attempt, last_error=error_msg
                )
