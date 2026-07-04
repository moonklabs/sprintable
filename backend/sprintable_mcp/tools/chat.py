"""채팅 MCP 도구 (3개)."""
from __future__ import annotations

import base64
import binascii
import logging

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput

logger = logging.getLogger(__name__)

# E-MCP-OPT S2(bbfd24ba): inline base64 첨부 — client-side fail-fast 가드(백엔드
# `_MAX_JSON_ATTACHMENT_UPLOAD_SIZE`와 정합·MCP 페이로드 낭비 전 조기 거부).
_MAX_ATTACHMENTS = 5
_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024  # 2MiB decoded/file
_MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024  # 2MiB decoded/total
_MAX_ATTACHMENT_BASE64_CHARS = ((_MAX_ATTACHMENT_BYTES + 2) // 3) * 4


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


def _validate_attachment(att: dict, index: int) -> tuple[dict, int]:
    if not isinstance(att, dict):
        raise ValueError(f"attachments[{index}] must be an object")
    name = str(att.get("name") or "").strip()
    content_type = str(att.get("content_type") or "").strip()
    content_base64 = str(att.get("content_base64") or "").strip()
    if not name:
        raise ValueError(f"attachments[{index}].name is required")
    if not content_type:
        raise ValueError(f"attachments[{index}].content_type is required")
    if not content_base64:
        raise ValueError(f"attachments[{index}].content_base64 is required")
    if len(content_base64) > _MAX_ATTACHMENT_BASE64_CHARS:
        raise ValueError(
            f"attachments[{index}] too large (max {_MAX_ATTACHMENT_BYTES} decoded bytes)"
        )
    try:
        decoded = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError(f"attachments[{index}].content_base64 must be valid base64")
    if not decoded:
        raise ValueError(f"attachments[{index}] must not be empty")
    if len(decoded) > _MAX_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachments[{index}] too large (max {_MAX_ATTACHMENT_BYTES} decoded bytes)"
        )
    return {"content_base64": content_base64, "name": name, "content_type": content_type}, len(decoded)


async def _upload_attachments(thread_id: str, attachments: list[dict] | None) -> list[dict]:
    """각 첨부를 신규 업로드 엔드포인트에 순차 업로드해 MessageAttachment 메타 리스트로 변환.

    개수/사이즈 가드는 **전부 먼저 검증**(네트워크 호출 0)한 다음에야 업로드를 시작한다 — 순차
    검증+업로드를 인터리빙하면 총량 초과가 마지막 파일에서만 드러날 때 앞선 파일들이 이미 실제
    업로드돼 orphan blob 이 되고서야 실패하는 낭비/누출이 생긴다.
    """
    if not attachments:
        return []
    if len(attachments) > _MAX_ATTACHMENTS:
        raise ValueError(f"too many attachments (max {_MAX_ATTACHMENTS})")

    validated: list[tuple[dict, int]] = [_validate_attachment(att, i) for i, att in enumerate(attachments)]
    total_size = sum(size for _payload, size in validated)
    if total_size > _MAX_TOTAL_ATTACHMENT_BYTES:
        raise ValueError(
            f"attachments total too large (max {_MAX_TOTAL_ATTACHMENT_BYTES} decoded bytes)"
        )

    uploaded: list[dict] = []
    for payload, _size in validated:
        uploaded.append(
            await client.post(f"/api/v2/conversations/{thread_id}/attachments", json=payload)
        )
    return uploaded


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
        attachments = await _upload_attachments(args.thread_id, args.attachments)
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
