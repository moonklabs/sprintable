"""E-EVENTBUS P4 S15: Chat 백엔드 — 실시간 메시지 이벤트 + MCP 채팅 도구."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.memo import Memo, MemoReply
from app.models.team import TeamMember
from app.repositories.memo import MemoReplyRepository
from app.routers.events import _push_to_agent
from app.schemas.memo import ReplyResponse

router = APIRouter(prefix="/api/v2/chats", tags=["chats"])


async def _persist_and_push_chat_events(
    db: AsyncSession,
    memo: Memo,
    reply: MemoReply,
    org_id: uuid.UUID,
    sender_id: uuid.UUID,
    participants: set[uuid.UUID],
    payload: dict,
) -> None:
    """chat:message Event를 events 테이블에 INSERT 후 SSE push (에이전트 대상)."""
    if not participants or not memo.project_id:
        return
    member_types_result = await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participants))
    )
    member_type_map = {row[0]: row[1] for row in member_types_result.all()}
    for participant_id in participants:
        member_type = member_type_map.get(participant_id, "human")
        event = Event(
            project_id=memo.project_id,
            org_id=org_id,
            event_type="chat:message",
            source_entity_type="memo_reply",
            source_entity_id=reply.id,
            sender_id=sender_id,
            recipient_id=participant_id,
            recipient_type=member_type,
            payload=payload,
            status="pending",
        )
        db.add(event)
        if member_type == "agent":
            _push_to_agent(str(participant_id), payload)
    await db.flush()


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
    # Event INSERT + SSE push (commit 전에 flush, 오프라인 에이전트도 poll_events로 조회 가능)
    try:
        await _persist_and_push_chat_events(db, memo, reply, org_id, body.created_by, chat_participants, chat_payload)
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
    try:
        await _persist_and_push_chat_events(db, memo, reply, org_id, created_by, chat_participants, chat_payload)
    except Exception:
        pass

    await db.commit()
    return ReplyResponse.model_validate(reply)
