"""채팅 MCP 도구 (3개)."""
from __future__ import annotations

import logging

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput
from .attachments import upload_attachments

logger = logging.getLogger(__name__)


class SendChatInput(SprintableInput):
    thread_id: str
    content: str
    reply_thread_id: str | None = None
    message_type: str | None = None
    review_type: str | None = None
    metadata: dict | None = None
    # [{content_base64, name, content_type}, ...] — 스샷/작은 문서(최대 5개·파일당 2MiB·총 6MiB).
    attachments: list[dict] | None = None


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
    uploaded_urls: list[str] = []
    try:
        attachments = await upload_attachments(
            f"/api/v2/conversations/{args.thread_id}/attachments", args.attachments,
        )
        uploaded_urls = [a["url"] for a in attachments if isinstance(a, dict) and a.get("url")]
        if attachments:
            payload["attachments"] = attachments
        return ok(await client.post(f"/api/v2/conversations/{args.thread_id}/messages", json=payload))
    except Exception as exc:
        if uploaded_urls:
            # 업로드는 성공했으나 메시지 생성이 실패한 경우 — asset registry 는 SAVE-time(메시지
            # 저장 트랜잭션)에만 동기화되므로 이 객체들은 미등록 orphan blob 으로 남는다(무해·
            # data-loss 아님). 운영 가시성을 위해 로그만 남김(best-effort cleanup 대상 아님 —
            # storage 자체 GC/grace cron 이 있다면 그쪽이 담당).
            logger.warning(
                "send_chat_message: message create failed after %d attachment upload(s) — "
                "orphaned object(s): %s", len(uploaded_urls), uploaded_urls,
            )
        return err(str(exc))


async def create_conversation(args: CreateConversationInput) -> list[TextContent]:
    """새 conversation thread 생성."""
    if not client.project_id:
        return err("project_id not set — agent must be bound to a project before creating conversations")
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
