"""E-EVENTBUS P4 S15/S17/S30: Chat 백엔드 — 실시간 메시지 이벤트 + E2E 연결."""
import logging
import uuid
from datetime import datetime
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
from app.routers.events import _push_to_agent, publish_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/chats", tags=["chats"])


async def _resolve_sender(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> TeamMember:
    """auth context → sending TeamMember 조회.

    API key 경로: auth.user_id = team_member.id (직접 조회)
    JWT 경로: auth.user_id = supabase user_id → TeamMember.user_id 매핑
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        stmt = select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
    else:
        stmt = select(TeamMember).where(
            TeamMember.user_id == uuid.UUID(auth.user_id),
            TeamMember.org_id == org_id,
        )
    member = (await db.execute(stmt)).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=400, detail="Sender team member not found")
    return member


# ─── Chat message shape (matches ChatMessage TS interface) ─────────────────────

def _to_chat_message(reply: MemoReply, sender: TeamMember) -> dict:
    return {
        "id": str(reply.id),
        "thread_id": str(reply.memo_id),
        "content": reply.content,
        "sender": {
            "id": str(sender.id),
            "name": sender.name,
            "type": sender.type,
        },
        "attachments": reply.attachments or [],
        "created_at": reply.created_at.isoformat(),
    }


# ─── Participants helper ───────────────────────────────────────────────────────

async def _build_participants(
    db: AsyncSession,
    memo: Memo,
    thread_id: uuid.UUID,
    sender_id: uuid.UUID,
) -> set[uuid.UUID]:
    """chat:message 이벤트 수신자 세트 구성.

    assigned_to + created_by + 기존 thread reply senders 포함, 발신자 제거.
    assigned_to=null + sender==created_by 케이스에서 participants가 비는 문제 해소.
    """
    participants: set[uuid.UUID] = set()
    if memo.assigned_to:
        participants.add(memo.assigned_to)
    if memo.created_by:
        participants.add(memo.created_by)

    # 기존 thread 참여자 포함 (이전 reply sender)
    prior_result = await db.execute(
        select(MemoReply.created_by)
        .where(MemoReply.memo_id == thread_id, MemoReply.created_by.isnot(None))
        .distinct()
    )
    for row in prior_result.all():
        if row[0]:
            participants.add(row[0])

    participants.discard(sender_id)
    return participants


# ─── Internal SSE push helper ──────────────────────────────────────────────────

async def _persist_and_push_chat_events(
    db: AsyncSession,
    memo: Memo,
    reply: MemoReply,
    org_id: uuid.UUID,
    sender: TeamMember,
    participants: set[uuid.UUID],
) -> None:
    """chat:message Event INSERT → SSE push.

    에이전트: _push_to_agent (agent SSE stream)
    사람: publish_event → /api/v2/events/memos SSE stream (Chat UI 실시간 수신)
    """
    if not memo.project_id:
        logger.warning("chat event skipped: memo.project_id is None memo_id=%s", reply.memo_id)
        return
    if not participants:
        logger.warning("chat event skipped: participants empty memo_id=%s sender_id=%s", reply.memo_id, sender.id)
        return

    chat_msg = _to_chat_message(reply, sender)

    member_rows = await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participants))
    )
    member_type_map = {row[0]: row[1] for row in member_rows.all()}

    for participant_id in participants:
        member_type = member_type_map.get(participant_id, "human")
        event = Event(
            project_id=memo.project_id,
            org_id=org_id,
            event_type="chat:message",
            source_entity_type="memo_reply",
            source_entity_id=reply.id,
            sender_id=sender.id,
            recipient_id=participant_id,
            recipient_type=member_type,
            payload=chat_msg,
            status="pending",
        )
        db.add(event)
        if member_type == "agent":
            _push_to_agent(str(participant_id), chat_msg)
        else:
            publish_event(str(org_id), "chat:message", chat_msg)

    await db.flush()


# ─── Request schema ────────────────────────────────────────────────────────────

class ChatMessageRequest(BaseModel):
    content: str
    attachments: list[dict] = []


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{thread_id}/messages")
async def list_chat_messages(
    thread_id: uuid.UUID,
    limit: int = Query(default=30, le=200),
    before: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/chats/{thread_id}/messages — 커서 기반 페이지네이션 메시지 조회.

    before: ISO timestamp 커서 (이 시각보다 오래된 메시지 조회).
    응답: { data: ChatMessage[], meta: { next_cursor, has_more } }
    """
    memo_result = await db.execute(
        select(Memo.id).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    if memo_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    stmt = (
        select(MemoReply)
        .where(MemoReply.memo_id == thread_id)
        .order_by(MemoReply.created_at.desc())
        .limit(limit + 1)
    )
    if before:
        try:
            before_dt = datetime.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor format")
        stmt = stmt.where(MemoReply.created_at < before_dt)

    rows = (await db.execute(stmt)).scalars().all()

    has_more = len(rows) > limit
    replies = list(reversed(rows[:limit]))  # 시간 오름차순

    # sender 일괄 조회
    sender_ids = {r.created_by for r in replies}
    members = (await db.execute(select(TeamMember).where(TeamMember.id.in_(sender_ids)))).scalars().all()
    member_map = {m.id: m for m in members}

    data = [_to_chat_message(r, member_map[r.created_by]) for r in replies if r.created_by in member_map]
    next_cursor = replies[0].created_at.isoformat() if has_more and replies else None

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}


@router.post("/{thread_id}/messages", status_code=201)
async def send_chat_message(
    thread_id: uuid.UUID,
    body: ChatMessageRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/chats/{thread_id}/messages — 채팅 메시지 전송 (JSON).

    응답: { data: ChatMessage }
    """
    memo_result = await db.execute(
        select(Memo).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    memo = memo_result.scalar_one_or_none()
    if memo is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    sender = await _resolve_sender(auth, org_id, db)

    reply_repo = MemoReplyRepository(db)
    reply = await reply_repo.create(
        memo_id=thread_id,
        content=body.content,
        created_by=sender.id,
        review_type="comment",
        attachments=body.attachments,
    )

    participants = await _build_participants(db, memo, thread_id, sender.id)

    try:
        async with db.begin_nested():
            await _persist_and_push_chat_events(db, memo, reply, org_id, sender, participants)
    except Exception:
        logger.exception("chat event insert failed thread_id=%s reply_id=%s", thread_id, reply.id)

    await db.commit()
    return {"data": _to_chat_message(reply, sender)}


@router.post("/{thread_id}/messages/upload", status_code=201)
async def send_chat_message_with_file(
    thread_id: uuid.UUID,
    content: Annotated[str, Form()],
    file: Annotated[UploadFile | None, File()] = None,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/chats/{thread_id}/messages/upload — 파일 첨부 포함 채팅 메시지 전송.

    응답: { data: ChatMessage }
    created_by는 auth context에서 파생 (form field 불필요).
    """
    memo_result = await db.execute(
        select(Memo).where(Memo.id == thread_id, Memo.org_id == org_id, Memo.deleted_at.is_(None))
    )
    memo = memo_result.scalar_one_or_none()
    if memo is None:
        raise HTTPException(status_code=404, detail="Thread not found")

    sender = await _resolve_sender(auth, org_id, db)

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
        created_by=sender.id,
        review_type="comment",
        attachments=attachments,
    )

    participants = await _build_participants(db, memo, thread_id, sender.id)

    try:
        async with db.begin_nested():
            await _persist_and_push_chat_events(db, memo, reply, org_id, sender, participants)
    except Exception:
        logger.exception("chat event insert failed (upload) thread_id=%s reply_id=%s", thread_id, reply.id)

    await db.commit()
    return {"data": _to_chat_message(reply, sender)}
