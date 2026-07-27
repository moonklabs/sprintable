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
        result = await client.get("/api/v2/notifications", params=params)
        # story #2195: BE 응답이 bare array → {data, meta}(#2231 정본 규약 A)로 바뀜.
        # 이 MCP 툴의 계약(호출 에이전트가 보는 모양)은 유지한다 — data만 꺼내 돌려준다.
        items = result.get("data", result) if isinstance(result, dict) else result
        return ok(items)
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
