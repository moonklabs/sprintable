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

from app.models.webhook_config import WebhookConfig


def _build_signature_headers(secret: str | None, body: str) -> dict[str, str]:
    if not secret:
        return {}
    ts = str(int(time.time() * 1000))
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return {
        "X-Sprintable-Signature": f"sha256={sig}",
        "X-Sprintable-Timestamp": ts,
    }


async def fire_webhooks(session: AsyncSession, org_id: uuid.UUID, event: str, data: dict[str, Any]) -> None:
    result = await session.execute(
        select(WebhookConfig.url, WebhookConfig.secret, WebhookConfig.events)
        .where(WebhookConfig.org_id == org_id, WebhookConfig.is_active.is_(True))
    )
    configs = result.all()
    if not configs:
        return

    payload_obj = {"event": event, "data": data}
    body = json.dumps(payload_obj)

    async with httpx.AsyncClient(timeout=10.0) as client:
        for row in configs:
            url, secret, events = row
            if events and event not in events:
                continue
            headers = {"Content-Type": "application/json", **_build_signature_headers(secret, body)}
            try:
                await client.post(url, content=body, headers=headers)
            except Exception:
                pass
