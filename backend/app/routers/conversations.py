"""E-EVENTBUS P7-A S37: conversations 테이블 + Chat API."""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.event import Event
from app.models.team import TeamMember
from app.routers.events import _push_to_agent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/conversations", tags=["conversations"])


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _resolve_member(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> TeamMember:
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        stmt = select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
    else:
        stmt = select(TeamMember).where(
            TeamMember.user_id == uuid.UUID(auth.user_id),
            TeamMember.org_id == org_id,
        )
    member = (await db.execute(stmt)).scalars().first()
    if member is None:
        raise HTTPException(status_code=400, detail="Team member not found")
    return member


def _msg_payload(msg: ConversationMessage, sender: TeamMember | None) -> dict:
    return {
        "id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "content": msg.content,
        "mentioned_ids": [str(m) for m in (msg.mentioned_ids or [])],
        "sender": {
            "id": str(sender.id),
            "name": sender.name,
            "type": sender.type,
        } if sender else None,
        "created_at": msg.created_at.isoformat(),
    }


async def _dispatch_conversation_event(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: TeamMember,
) -> None:
    """conversation:message → 전 참여자 SSE dispatch + Event INSERT."""
    if not conversation.project_id:
        return

    payload = _msg_payload(msg, sender)

    # 참여자 조회
    rows = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation.id)
    )).all()
    participant_ids = {r[0] for r in rows} - {sender.id}

    if not participant_ids:
        return

    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participant_ids))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    for pid in participant_ids:
        m_type = member_type_map.get(pid, "human")
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation:message",
            source_entity_type="conversation_message",
            source_entity_id=msg.id,
            sender_id=sender.id,
            recipient_id=pid,
            recipient_type=m_type,
            payload=payload,
            status="pending",
        )
        db.add(event)
        # human/agent 모두 per-member push — org 전체 브로드캐스트 방지
        _push_to_agent(str(pid), {"event_type": "conversation:message", **payload})

    await db.flush()


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CreateConversationRequest(BaseModel):
    type: str = "group"  # dm | group
    title: str | None = None
    participant_ids: list[uuid.UUID]
    project_id: uuid.UUID


class SendMessageRequest(BaseModel):
    content: str
    mentioned_ids: list[uuid.UUID] = []


class AddParticipantRequest(BaseModel):
    member_id: uuid.UUID


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations — dm/group 생성 (dm 중복 방지)."""
    sender = await _resolve_member(auth, org_id, db)

    # DM 중복 방지: 동일 participant pair의 dm이 이미 있으면 반환
    if body.type == "dm" and len(body.participant_ids) == 1:
        other_id = body.participant_ids[0]
        existing = (await db.execute(
            select(Conversation.id)
            .join(ConversationParticipant, ConversationParticipant.conversation_id == Conversation.id)
            .where(
                Conversation.type == "dm",
                Conversation.org_id == org_id,
                Conversation.project_id == body.project_id,
                ConversationParticipant.member_id == sender.id,
            )
        )).scalars().all()

        for conv_id in existing:
            other_check = (await db.execute(
                select(ConversationParticipant.id).where(
                    ConversationParticipant.conversation_id == conv_id,
                    ConversationParticipant.member_id == other_id,
                )
            )).scalar_one_or_none()
            if other_check:
                return {"id": str(conv_id), "type": "dm", "existing": True}

    conv = Conversation(
        project_id=body.project_id,
        org_id=org_id,
        type=body.type,
        title=body.title,
        created_by=sender.id,
    )
    db.add(conv)
    await db.flush()

    all_members = list({sender.id} | set(body.participant_ids))
    for mid in all_members:
        db.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))

    await db.commit()
    await db.refresh(conv)
    return {"id": str(conv.id), "type": conv.type, "title": conv.title, "existing": False}


@router.get("")
async def list_conversations(
    project_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations — 최근 메시지 미리보기 + 참여 대화 목록."""
    sender = await _resolve_member(auth, org_id, db)

    conv_ids_result = await db.execute(
        select(ConversationParticipant.conversation_id).where(
            ConversationParticipant.member_id == sender.id
        )
    )
    conv_ids = [r[0] for r in conv_ids_result.all()]

    if not conv_ids:
        return {"data": []}

    convs = (await db.execute(
        select(Conversation)
        .where(Conversation.id.in_(conv_ids), Conversation.org_id == org_id, Conversation.project_id == project_id)
        .order_by(Conversation.updated_at.desc())
    )).scalars().all()

    # participants 배치 조회 (N+1 방지)
    conv_id_list = [c.id for c in convs]
    p_rows = (await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id.in_(conv_id_list))
    )).all()

    all_member_ids = {r.member_id for r in p_rows}
    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.name, TeamMember.avatar_url)
        .where(TeamMember.id.in_(all_member_ids))
    )).all() if all_member_ids else []
    member_map = {r.id: {"name": r.name, "avatar_url": r.avatar_url} for r in member_rows}

    conv_participants: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for r in p_rows:
        info = member_map.get(r.member_id, {})
        conv_participants[r.conversation_id].append({
            "member_id": str(r.member_id),
            "name": info.get("name"),
            "avatar_url": info.get("avatar_url"),
        })

    result = []
    for conv in convs:
        latest_msg = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.conversation_id == conv.id)
            .order_by(ConversationMessage.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()

        result.append({
            "id": str(conv.id),
            "type": conv.type,
            "title": conv.title,
            "participants": conv_participants.get(conv.id, []),
            "latest_message": {
                "content": latest_msg.content,
                "created_at": latest_msg.created_at.isoformat(),
            } if latest_msg else None,
            "updated_at": conv.updated_at.isoformat(),
        })

    return {"data": result}


@router.get("/{conversation_id}/messages")
async def list_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(default=30, le=200),
    before: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/{id}/messages — cursor 기반 페이지네이션."""
    sender = await _resolve_member(auth, org_id, db)

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    stmt = (
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conversation_id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(limit + 1)
    )
    if before:
        try:
            before_dt = datetime.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid cursor format")
        stmt = stmt.where(ConversationMessage.created_at < before_dt)

    rows = (await db.execute(stmt)).scalars().all()
    has_more = len(rows) > limit
    msgs = list(reversed(rows[:limit]))

    sender_ids = {m.sender_id for m in msgs if m.sender_id}
    members = (await db.execute(select(TeamMember).where(TeamMember.id.in_(sender_ids)))).scalars().all()
    member_map = {m.id: m for m in members}

    data = [_msg_payload(m, member_map.get(m.sender_id)) for m in msgs]
    next_cursor = msgs[0].created_at.isoformat() if has_more and msgs else None

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}


@router.post("/{conversation_id}/participants", status_code=201)
async def add_participant(
    conversation_id: uuid.UUID,
    body: AddParticipantRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/participants — 참여자 추가."""
    sender = await _resolve_member(auth, org_id, db)

    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # 요청자 참여 여부 확인
    is_participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if is_participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # 추가 대상 멤버가 같은 org인지 확인
    target = (await db.execute(
        select(TeamMember).where(TeamMember.id == body.member_id, TeamMember.org_id == org_id)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found")

    # DM → 기존 DM 유지, 기존 참여자 + 신규 참여자로 그룹 conversation fork
    if conv.type == "dm":
        existing_member_ids = (await db.execute(
            select(ConversationParticipant.member_id)
            .where(ConversationParticipant.conversation_id == conversation_id)
        )).scalars().all()

        new_conv = Conversation(
            project_id=conv.project_id,
            org_id=org_id,
            type="group",
            created_by=sender.id,
        )
        db.add(new_conv)
        await db.flush()

        all_member_ids = set(existing_member_ids) | {body.member_id}
        for mid in all_member_ids:
            db.add(ConversationParticipant(conversation_id=new_conv.id, member_id=mid))

        await db.commit()
        await db.refresh(new_conv)
        return {
            "conversation_id": str(new_conv.id),
            "member_id": str(body.member_id),
            "name": target.name,
            "avatar_url": target.avatar_url,
            "forked": True,
        }

    # group → 기존 conversation에 직접 추가
    try:
        db.add(ConversationParticipant(conversation_id=conversation_id, member_id=body.member_id))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Already a participant")

    return {
        "conversation_id": str(conversation_id),
        "member_id": str(body.member_id),
        "name": target.name,
        "avatar_url": target.avatar_url,
        "forked": False,
    }


@router.post("/{conversation_id}/messages", status_code=201)
async def send_message(
    conversation_id: uuid.UUID,
    body: SendMessageRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/messages — 전송 + SSE dispatch."""
    sender = await _resolve_member(auth, org_id, db)

    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    msg = ConversationMessage(
        conversation_id=conversation_id,
        sender_id=sender.id,
        content=body.content,
        mentioned_ids=body.mentioned_ids,
    )
    db.add(msg)
    await db.flush()

    try:
        async with db.begin_nested():
            await _dispatch_conversation_event(db, conv, msg, org_id, sender)
    except Exception:
        logger.exception("conversation event dispatch failed conversation_id=%s", conversation_id)

    # conversation updated_at 갱신
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(msg)
    return {"data": _msg_payload(msg, sender)}
