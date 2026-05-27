"""Webhook config 관리 MCP 도구 (3개)."""
from __future__ import annotations

import uuid

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class ListWebhookConfigsInput(SprintableInput):
    project_id: str | None = None


class UpsertWebhookConfigInput(SprintableInput):
    url: str
    project_id: str | None = None
    events: list[str] | None = None
    is_active: bool = True
    secret: str | None = None


class DeleteWebhookConfigInput(SprintableInput):
    id: str


async def list_webhook_configs(args: ListWebhookConfigsInput) -> list[TextContent]:
    """Webhook config 목록 조회."""
    params: dict = {}
    if args.project_id:
        params["project_id"] = args.project_id
    try:
        return ok(await client.get("/api/v2/webhooks/config", params=params))
    except Exception as exc:
        return err(str(exc))


async def upsert_webhook_config(args: UpsertWebhookConfigInput) -> list[TextContent]:
    """Webhook config 생성/수정. secret 설정 시 HMAC 서명 활성화."""
    if not client.member_id:
        return err("member_id not resolved")
    body: dict = {
        "member_id": client.member_id,
        "url": args.url,
        "is_active": args.is_active,
    }
    if args.project_id is not None:
        body["project_id"] = args.project_id
    if args.events is not None:
        body["events"] = args.events
    if args.secret is not None:
        body["secret"] = args.secret
    try:
        return ok(await client.put("/api/v2/webhooks/config", json=body))
    except Exception as exc:
        return err(str(exc))


async def delete_webhook_config(args: DeleteWebhookConfigInput) -> list[TextContent]:
    """Webhook config 삭제."""
    try:
        return ok(await client.delete("/api/v2/webhooks/config", params={"id": args.id}))
    except Exception as exc:
        return err(str(exc))
