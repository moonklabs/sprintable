"""메모+채팅 MCP 도구 (10개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class ListMemosInput(SprintableInput):
    assigned_to: str | None = None
    status: str | None = None
    q: str | None = None
    include_archived: bool | None = None


class CreateMemoInput(SprintableInput):
    content: str
    title: str | None = None
    memo_type: str | None = None
    assigned_to: str | None = None
    assigned_to_ids: list[str] | None = None
    story_id: str | None = None
    trigger_type: str | None = None


class ListMyMemosInput(SprintableInput):
    assigned_to: str | None = None
    created_by: str | None = None
    status: str | None = None


class MemoIdInput(SprintableInput):
    memo_id: str


class ReplyMemoInput(SprintableInput):
    memo_id: str
    content: str
    assigned_to: str | None = None
    assigned_to_ids: list[str] | None = None


class SendChatInput(SprintableInput):
    thread_id: str
    content: str
    reply_thread_id: str | None = None
    message_type: str | None = None
    review_type: str | None = None
    metadata: dict | None = None


class CreateConversationInput(SprintableInput):
    participant_ids: list[str]
    title: str | None = None


class ListChatMessagesInput(SprintableInput):
    thread_id: str
    limit: int | None = None
    before: str | None = None


async def list_memos(args: ListMemosInput) -> list[TextContent]:
    """메모 목록 조회."""
    params: dict = {"project_id": client.project_id}
    if args.assigned_to:
        params["assigned_to"] = args.assigned_to
    if args.status:
        params["status"] = args.status
    if args.q:
        params["q"] = args.q
    if args.include_archived:
        params["include_archived"] = "true"
    try:
        return ok(await client.get("/api/v2/memos", params=params))
    except Exception as exc:
        return err(str(exc))


async def create_memo(args: CreateMemoInput) -> list[TextContent]:
    """메모 생성."""
    body: dict = {"content": args.content, "project_id": client.project_id}
    if args.title:
        body["title"] = args.title
    if args.memo_type:
        body["memo_type"] = args.memo_type
    if args.assigned_to:
        body["assigned_to"] = args.assigned_to
    if args.assigned_to_ids:
        body["assigned_to_ids"] = args.assigned_to_ids
    if args.story_id:
        body["story_id"] = args.story_id
    if args.trigger_type:
        body["memo_metadata"] = {"trigger_type": args.trigger_type}
    try:
        return ok(await client.post("/api/v2/memos", json=body))
    except Exception as exc:
        return err(str(exc))


async def send_memo(args: CreateMemoInput) -> list[TextContent]:
    """[DEPRECATED] 메모 발송. create_memo와 동일 경로."""
    result = await create_memo(args)
    return result


async def list_my_memos(args: ListMyMemosInput) -> list[TextContent]:
    """내 메모 목록 조회 (담당/작성)."""
    params: dict = {"project_id": client.project_id}
    if args.assigned_to:
        params["assigned_to"] = args.assigned_to
    if args.created_by:
        params["created_by"] = args.created_by
    if args.status:
        params["status"] = args.status
    try:
        return ok(await client.get("/api/v2/memos", params=params))
    except Exception as exc:
        return err(str(exc))


async def read_memo(args: MemoIdInput) -> list[TextContent]:
    """메모 읽기 (conversation 우선, 없으면 memos fallback)."""
    try:
        msgs = await client.get(f"/api/v2/conversations/{args.memo_id}/messages")
        return ok({"id": args.memo_id, "conversation_id": args.memo_id, "replies": msgs})
    except Exception:
        pass
    try:
        return ok(await client.get(f"/api/v2/memos/{args.memo_id}"))
    except Exception as exc:
        return err(str(exc))


async def reply_memo(args: ReplyMemoInput) -> list[TextContent]:
    """[DEPRECATED] 메모 답신 (conversation thread reply로 라우팅)."""
    try:
        msgs = await client.get(f"/api/v2/conversations/{args.memo_id}/messages", params={"limit": "1"})
        root_msgs = msgs if isinstance(msgs, list) else (msgs.get("data") or [])
        root_msg_id = root_msgs[0].get("id") if root_msgs else None

        if root_msg_id:
            resolved_ids = args.assigned_to_ids or ([args.assigned_to] if args.assigned_to else None)
            payload: dict = {"content": args.content, "thread_id": root_msg_id}
            if resolved_ids:
                payload["mentioned_ids"] = resolved_ids
            msg = await client.post(f"/api/v2/conversations/{args.memo_id}/messages", json=payload)
            msg_data = msg if not isinstance(msg, dict) or "data" not in msg else msg["data"]
            return ok({"memo_id": args.memo_id, "conversation_id": args.memo_id, "message_id": msg_data.get("id") if isinstance(msg_data, dict) else None, "deprecated": True})
    except Exception:
        pass

    try:
        resolved_ids = args.assigned_to_ids or ([args.assigned_to] if args.assigned_to else None)
        payload = {"content": args.content}
        if resolved_ids:
            payload["assigned_to_ids"] = resolved_ids
        return ok(await client.post(f"/api/v2/memos/{args.memo_id}/replies", json=payload))
    except Exception as exc:
        return err(str(exc))


async def resolve_memo(args: MemoIdInput) -> list[TextContent]:
    """메모 해결 처리."""
    try:
        return ok(await client.patch(f"/api/v2/memos/{args.memo_id}/resolve"))
    except Exception as exc:
        return err(str(exc))


async def send_chat_message(args: SendChatInput) -> list[TextContent]:
    """conversation thread에 채팅 메시지 발송."""
    payload: dict = {"content": args.content}
    if args.reply_thread_id:
        payload["thread_id"] = args.reply_thread_id
    meta: dict = {}
    if args.metadata:
        meta.update(args.metadata)
    if args.message_type:
        meta["message_type"] = args.message_type
    if args.review_type:
        meta["review_type"] = args.review_type
    if meta:
        payload["metadata"] = meta
    try:
        return ok(await client.post(f"/api/v2/conversations/{args.thread_id}/messages", json=payload))
    except Exception as exc:
        return err(str(exc))


async def create_conversation(args: CreateConversationInput) -> list[TextContent]:
    """새 conversation thread 생성."""
    body: dict = {
        "type": "group",
        "participant_ids": args.participant_ids,
        "project_id": client.project_id,
    }
    if args.title:
        body["title"] = args.title
    try:
        conv = await client.post("/api/v2/conversations", json=body)
        conv_id = conv.get("id") if isinstance(conv, dict) else None
        return ok({"conversation_id": conv_id, **(conv if isinstance(conv, dict) else {})})
    except Exception as exc:
        return err(str(exc))


async def list_chat_messages(args: ListChatMessagesInput) -> list[TextContent]:
    """conversation thread 메시지 목록 조회."""
    params: dict = {}
    if args.limit is not None:
        params["limit"] = str(args.limit)
    if args.before:
        params["before"] = args.before
    try:
        return ok(await client.get(f"/api/v2/conversations/{args.thread_id}/messages", params=params))
    except Exception as exc:
        return err(str(exc))
