"""알림 관련 MCP 도구 (3개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class CheckNotificationsInput(SprintableInput):
    unread: bool | None = None
    type: str | None = None
    limit: int | None = None


class MarkNotificationReadInput(SprintableInput):
    notification_id: str
    is_read: bool | None = None


class MarkAllNotificationsReadInput(SprintableInput):
    type: str | None = None


async def check_notifications(args: CheckNotificationsInput) -> list[TextContent]:
    """알림 목록 조회."""
    params: dict = {}
    if args.unread:
        params["unread"] = "true"
    if args.type:
        params["type"] = args.type
    if args.limit:
        params["limit"] = str(args.limit)
    try:
        return ok(await client.get("/api/v2/notifications", params=params))
    except Exception as exc:
        return err(str(exc))


async def mark_notification_read(args: MarkNotificationReadInput) -> list[TextContent]:
    """알림 읽음 처리."""
    body: dict = {"id": args.notification_id, "is_read": args.is_read if args.is_read is not None else True}
    try:
        return ok(await client.patch("/api/v2/notifications", json=body))
    except Exception as exc:
        return err(str(exc))


async def mark_all_notifications_read(args: MarkAllNotificationsReadInput) -> list[TextContent]:
    """전체 알림 읽음 처리."""
    body: dict = {"markAllRead": True}
    if args.type:
        body["type"] = args.type
    try:
        return ok(await client.patch("/api/v2/notifications", json=body))
    except Exception as exc:
        return err(str(exc))
