"""채팅 MCP 도구 (3개)."""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


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
