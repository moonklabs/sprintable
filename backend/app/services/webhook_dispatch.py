"""Shared webhook dispatch utility."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ssrf import validate_webhook_url_async
from app.models.webhook_config import WebhookConfig
# c60dd33c: Discord 페이로드 정규화 공용 헬퍼(채팅 경로와 단일화).
from app.services.discord_webhook import is_discord_url, to_discord_event_payload


def _build_signature_headers(secret: str | None, body: str) -> dict[str, str]:
    if not secret:
        return {}
    ts = str(int(time.time() * 1000))
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return {
        "X-Sprintable-Signature": f"sha256={sig}",
        "X-Sprintable-Timestamp": ts,
    }


async def fire_webhooks(
    session: AsyncSession,
    org_id: uuid.UUID,
    event: str,
    data: dict[str, Any],
    *,
    recipient_member_ids: set[uuid.UUID] | None = None,
    preserve_broadcast: bool = True,
) -> None:
    """org webhook 발화 (c60dd33c).

    **Discord 정규화(AC1)**: discord URL 에는 raw envelope 대신 ``{content|embeds}`` 변환
    (``to_discord_event_payload``)을 보낸다 — 기존엔 raw envelope POST 라 discord 전원 400.
    채팅 경로(conversation_webhook)와 동일 헬퍼·동형 거동. routing/retry/status 는 불변.

    **타겟 게이팅(AC2·opt-in)**: ``recipient_member_ids`` 가 주어지면 member-bound webhook
    (``member_id`` != null)은 그 집합의 멤버만 수신해 story/activity 의 org-wide 과다 fan-out 을
    차단한다. ``member_id IS NULL`` 진짜 activity-feed 브로드캐스트는 ``preserve_broadcast`` 시
    보존. **``recipient_member_ids`` 가 None(기본)이면 게이팅 없음 = 기존 fan-out 동작**이라 타
    호출부(file_conflict·assignee_changed·workflow_violation)는 무회귀.
    """
    result = await session.execute(
        select(
            WebhookConfig.url,
            WebhookConfig.secret,
            WebhookConfig.events,
            WebhookConfig.member_id,
        ).where(WebhookConfig.org_id == org_id, WebhookConfig.is_active.is_(True))
    )
    configs = result.all()
    if not configs:
        return

    envelope_body = json.dumps({"event": event, "data": data})
    discord_body = json.dumps(to_discord_event_payload(event, data))

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
        for url, secret, events, member_id in configs:
            if events and event not in events:
                continue
            # AC2 게이팅(opt-in): recipient_member_ids 주어진 경우만 적용. None=기존 동작.
            if recipient_member_ids is not None:
                if member_id is None:
                    if not preserve_broadcast:
                        continue  # broadcast 인데 보존 끄면 drop
                elif member_id not in recipient_member_ids:
                    continue  # member-bound 인데 관련자 아님 → drop(과다 fan-out 차단)
            # dispatch 시 IP 재검증 (DNS rebinding 방지)
            try:
                await validate_webhook_url_async(url)
            except ValueError:
                continue
            if is_discord_url(url):
                # AC1: Discord 는 {content|embeds} 필수 + 서명 헤더 없음(채팅 경로와 동형).
                body = discord_body
                headers = {"Content-Type": "application/json"}
            else:
                body = envelope_body
                headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
            try:
                await client.post(url, content=body, headers=headers)
            except Exception:
                pass


async def deliver_test_webhook(url: str, secret: str | None) -> tuple[bool, str | None]:
    """0a6487c6-BE: 단일 합성 'TEST' webhook 1발 → ``(reached, reason)``.

    사용자 제공 URL 이라 **SSRF 재검증 필수**(DNS rebinding). 실 알림 오인 방지 — event=``webhook.test``·
    ``label='TEST'`` 명시. Discord URL 은 ``{content|embeds}`` 로 정규화(c60dd33c·아니면 Discord 400).
    ``reached`` = 목적지 2xx 응답. fire_webhooks 의 서명/검증 경로와 동형(거동 불변).
    """
    from datetime import datetime, timezone
    data = {
        "label": "TEST",
        "message": "Sprintable 알림 목적지 연결 테스트 — 이 메시지가 보이면 정상 연결입니다.",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await validate_webhook_url_async(url)
    except ValueError:
        return False, "unsafe or invalid url"
    if is_discord_url(url):
        # 범용 포매터는 event 명만 싣어(label 누락) TEST 임을 못 알림 — 자가진단용은 명시 TEST 문구.
        body = json.dumps({"content": f"🔔 **[TEST]** {data['message']}"})
        headers = {"Content-Type": "application/json"}
    else:
        body = json.dumps({"event": "webhook.test", "data": data})
        headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.post(url, content=body, headers=headers)
    except Exception as exc:
        return False, f"delivery error: {type(exc).__name__}"
    if 200 <= resp.status_code < 300:
        return True, None
    return False, f"HTTP {resp.status_code}"
