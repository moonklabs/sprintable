"""story 4646 — 메시지 첨부 하나를 에이전트가 읽을 형태로 돌려준다(엔드포인트 · MCP 도구가 함께 쓴다).

순서(까디르 렌즈 ①–④ · 정본 인가 = conversations._authorize_message_read):
1. 인가: _authorize_message_read(대화 참가 · agent-only 규칙 · 404/403) — get_message와 같은 함수.
2. 메시지: id = message_id AND conversation_id = conversation_id. 없음 · tombstone(deleted_at) → 404.
3. 첨부 항목: index 범위 밖 · 항목이 dict가 아님 → 404(같은 메시지).
4. 키 범위: 저장 url → canonical 객체 경로 → path_in_source_scope(이 대화 · 이 조직 접두어) 통과해야 읽는다. 아니면 404.
5. 크기 게이트(내려받기 前): head_object → should_download. 모르거나 상한 초과면 내려받지 않고 메타만.
6. 내려받기 → 이미지는 prepare_image(허용 형식 · EXIF · 축소), 텍스트는 text_body(확장자 · UTF-8 · 200KB).
   열지 못하면 메타만.
"""
from __future__ import annotations

import base64
import os
import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext
from app.models.conversation import ConversationMessage
from app.routers.conversations import _authorize_message_read
from app.services.asset_registry import canonical_object_path, path_in_source_scope
from app.services.chat_attachment_read import (IMAGE_EXTS, TEXT_EXTS, MAX_TEXT_BYTES, prepare_image, should_download, text_body)
from app.services.storage import get_storage_provider

_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")


@dataclass(frozen=True)
class AttachmentRead:
    kind: str           # "image" | "text" | "meta"
    name: str
    content_type: str
    size: int | None
    reason: str | None  # meta 일 때 이유(too_large · unknown_size · unreadable · unsupported · scope)
    data_base64: str | None = None   # image
    width: int | None = None
    height: int | None = None
    text: str | None = None          # text


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


async def read_message_attachment(
    db: AsyncSession, auth: AuthContext, org_id: uuid.UUID,
    conversation_id: uuid.UUID, message_id: uuid.UUID, index: int,
) -> AttachmentRead:
    project_id = await _authorize_message_read(conversation_id, db, auth, org_id)  # 1 · 정본 인가
    msg = (await db.execute(select(ConversationMessage).where(
        ConversationMessage.id == message_id, ConversationMessage.conversation_id == conversation_id,
    ))).scalar_one_or_none()
    if msg is None or msg.deleted_at is not None:  # 2 · tombstone은 없는 것과 같다
        raise HTTPException(status_code=404, detail="Message not found")
    items = msg.attachments or []
    if index < 0 or index >= len(items) or not isinstance(items[index], dict):  # 3
        raise HTTPException(status_code=404, detail="Attachment not found")
    a = items[index]
    name = (a.get("name") or "attachment").strip() or "attachment"  # 빈 이름 표시 — 사람 문장이 아니라 중립값
    ctype = (a.get("content_type") or "").strip().lower()
    ext = _ext(name)
    obj = canonical_object_path(a.get("url") or "")
    if obj is None or not path_in_source_scope(obj, "conversation_message", project_id, conversation_id, org_id):  # 4
        raise HTTPException(status_code=404, detail="Attachment not found")

    storage = get_storage_provider()
    size = await storage.head_object(_BUCKET, obj)  # 5 · 내려받기 前
    is_image = ctype.startswith("image/") or ext in IMAGE_EXTS
    is_text = (not is_image) and ext in TEXT_EXTS
    if not (is_image or is_text):
        return AttachmentRead("meta", name, ctype, size, "unsupported")
    if size is None:
        return AttachmentRead("meta", name, ctype, size, "unknown_size")
    if is_text and size > MAX_TEXT_BYTES:
        return AttachmentRead("meta", name, ctype, size, "too_large")
    if is_image and not should_download(size):
        return AttachmentRead("meta", name, ctype, size, "too_large")

    raw = await storage.download_object(_BUCKET, obj)  # 6
    if is_text:
        body = text_body(raw, ext)
        if body is None:
            return AttachmentRead("meta", name, ctype, size, "unreadable")
        return AttachmentRead("text", name, ctype, size, None, text=body)
    prepared = prepare_image(raw)
    if prepared is None:
        return AttachmentRead("meta", name, ctype, size, "unreadable")
    return AttachmentRead(
        "image", name, prepared.mime_type, size, None,
        data_base64=base64.b64encode(prepared.data).decode(),
        width=prepared.width, height=prepared.height,
    )
