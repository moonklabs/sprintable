"""E-EVENTBUS P4 S15: Chat 백엔드 — 실시간 메시지 이벤트 + MCP 채팅 도구."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.memo import Memo, MemoReply
from app.repositories.memo import MemoReplyRepository
from app.routers.events import _push_to_agent
from app.schemas.memo import ReplyResponse

router = APIRouter(prefix="/api/v2/chats", tags=["chats"])


class ChatMessageRequest(BaseModel):
    content: str
    created_by: uuid.UUID
    attachments: list[dict] = []


@router.get("/{thread_id}/messages", response_model=list[ReplyResponse])
async def list_chat_messages(
    thread_id: uuid.UUID,
    limit: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[ReplyResponse]:
    """GET /api/v2/chats/{thread_id}/messages — 시간순 메시지 조회."""
    memo_result = await db.execute(
        select(Memo.id).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    if memo_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    result = await db.execute(
        select(MemoReply)
        .where(MemoReply.memo_id == thread_id)
        .order_by(MemoReply.created_at.asc())
        .limit(limit)
    )
    replies = result.scalars().all()
    return [ReplyResponse.model_validate(r) for r in replies]


@router.post("/{thread_id}/messages", response_model=ReplyResponse, status_code=201)
async def send_chat_message(
    thread_id: uuid.UUID,
    body: ChatMessageRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ReplyResponse:
    """POST /api/v2/chats/{thread_id}/messages — 채팅 메시지 전송 (JSON)."""
    memo_result = await db.execute(
        select(Memo).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    memo = memo_result.scalar_one_or_none()
    if memo is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=thread_id,
        content=body.content,
        created_by=body.created_by,
        review_type="comment",
        attachments=body.attachments,
    )

    # chat:message 이벤트 → thread 참여자 SSE 전달
    try:
        chat_participants: set[uuid.UUID] = set()
        if memo.assigned_to:
            chat_participants.add(memo.assigned_to)
        if memo.created_by:
            chat_participants.add(memo.created_by)
        chat_participants.discard(body.created_by)
        chat_payload = {
            "event_type": "chat:message",
            "thread_id": str(thread_id),
            "reply_id": str(reply.id),
            "content": reply.content,
            "created_by": str(reply.created_by),
            "attachments": reply.attachments,
            "created_at": reply.created_at.isoformat(),
        }
        for participant_id in chat_participants:
            _push_to_agent(str(participant_id), chat_payload)
    except Exception:
        pass

    await db.commit()
    return ReplyResponse.model_validate(reply)


@router.post("/{thread_id}/messages/upload", response_model=ReplyResponse, status_code=201)
async def send_chat_message_with_file(
    thread_id: uuid.UUID,
    content: Annotated[str, Form()],
    created_by: Annotated[uuid.UUID, Form()],
    file: Annotated[UploadFile | None, File()] = None,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ReplyResponse:
    """POST /api/v2/chats/{thread_id}/messages/upload — 파일 첨부 포함 채팅 메시지 전송 (multipart)."""
    memo_result = await db.execute(
        select(Memo).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    memo = memo_result.scalar_one_or_none()
    if memo is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    attachments: list[dict] = []
    if file and file.filename:
        file_content = await file.read()
        attachments.append({
            "filename": file.filename,
            "content_type": file.content_type or "application/octet-stream",
            "size": len(file_content),
        })

    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=thread_id,
        content=content,
        created_by=created_by,
        review_type="comment",
        attachments=attachments,
    )

    # chat:message SSE 전달
    try:
        chat_participants: set[uuid.UUID] = set()
        if memo.assigned_to:
            chat_participants.add(memo.assigned_to)
        if memo.created_by:
            chat_participants.add(memo.created_by)
        chat_participants.discard(created_by)
        chat_payload = {
            "event_type": "chat:message",
            "thread_id": str(thread_id),
            "reply_id": str(reply.id),
            "content": reply.content,
            "created_by": str(reply.created_by),
            "attachments": reply.attachments,
            "created_at": reply.created_at.isoformat(),
        }
        for participant_id in chat_participants:
            _push_to_agent(str(participant_id), chat_payload)
    except Exception:
        pass

    await db.commit()
    return ReplyResponse.model_validate(reply)
