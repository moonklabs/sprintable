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
    before: str | None = None  # #2195: 이전 호출의 meta.next_cursor 값을 그대로 넘기면 다음 페이지


class MarkNotificationReadInput(SprintableInput):
    notification_id: str
    is_read: bool | None = None


class MarkAllNotificationsReadInput(SprintableInput):
    type: str | None = None


async def check_notifications(args: CheckNotificationsInput) -> list[TextContent]:
    """알림 목록 조회. 더 있으면(has_more) 다음 페이지 안내가 별도 텍스트 블록으로 붙는다."""
    params: dict = {}
    if args.unread:
        params["unread"] = "true"
    if args.type:
        params["type"] = args.type
    if args.limit:
        params["limit"] = str(args.limit)
    if args.before:
        params["before"] = args.before
    try:
        result = await client.get("/api/v2/notifications", params=params)
        # story #2195 후속(오르테가군 지적): BE 응답이 bare array → {data,meta}(#2231 규약 A)로
        # 바뀐 뒤 그냥 배열만 언랩해 돌려주면, 사람 화면에서 고친 "목록이 조용히 끝난 척한다"
        # 병을 에이전트 표면에 그대로 남기게 된다. 1차 블록(배열)은 기존 툴 계약대로 유지하되,
        # has_more일 때 다음 페이지 안내를 2차 텍스트 블록으로 덧붙여 에이전트가 "전량을 못
        # 봤다"를 알고 before 커서로 이어 받을 수 있게 한다.
        if isinstance(result, dict) and "data" in result:
            items = result["data"]
            meta = result.get("meta") or {}
        else:
            items = result
            meta = {}
        blocks = ok(items)
        if meta.get("has_more"):
            blocks.append(TextContent(
                type="text",
                text=(
                    f"※ 더 있음 — 이 응답은 {len(items)}건까지만 포함(전량 아님). "
                    f'다음 페이지: check_notifications를 before="{meta.get("next_cursor")}"로 다시 호출.'
                ),
            ))
        return blocks
    except Exception as exc:
        return err(str(exc))


async def mark_notification_read(args: MarkNotificationReadInput) -> list[TextContent]:
    """알림 읽음 처리 — story #2281 AC3ⓒ: 단건 읽음처리 라우트가 서버에 없다(#2271 발견).
    ⓐ(서버에 만든다)는 알림 자체의 재설계(#2201·#2279)와 순서가 얽혀 PO가 순서를 잡기로
    했다 — 그때까지 이 도구는 «조용한 404» 대신 명시적으로 미지원임을 말한다(AC4)."""
    return err(
        "단건 알림 읽음처리는 서버에 아직 구현돼 있지 않습니다(story #2281 — "
        "알림 재설계 #2201/#2279와 순서가 얽혀 보류 중). 전체 읽음처리는 "
        "mark_all_notifications_read를 쓰세요."
    )


async def mark_all_notifications_read(args: MarkAllNotificationsReadInput) -> list[TextContent]:
    """전체 알림 읽음 처리 — story #2281 AC1: 경로가 틀렸었다(#2271). 서버는 body를
    아예 안 받는다(auth로만 전체를 읽음처리) — type 필터는 서버 미지원이라 조용히
    무시하지 않고 명시 오류로 막는다(AC4)."""
    if args.type:
        return err(
            "mark_all_notifications_read의 type 필터는 서버가 아직 지원하지 않습니다"
            "(무시하고 전체를 읽음처리하면 의도와 다른 결과가 조용히 발생하므로 막습니다)."
        )
    try:
        return ok(await client.patch("/api/v2/notifications/mark-all-read"))
    except Exception as exc:
        return err(str(exc))
