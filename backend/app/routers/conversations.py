"""E-EVENTBUS P7-A S37: conversations 테이블 + Chat API."""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.event import Event
from app.models.team import TeamMember
from app.models.webhook_config import WebhookConfig
from app.routers.events import _push_to_agent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/conversations", tags=["conversations"])


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _resolve_member(
    auth: AuthContext,
    org_id: uuid.UUID,
    db: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> TeamMember:
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        stmt = select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
    else:
        filters = [
            TeamMember.user_id == uuid.UUID(auth.user_id),
            TeamMember.org_id == org_id,
        ]
        if project_id is not None:
            filters.append(TeamMember.project_id == project_id)
        stmt = select(TeamMember).where(*filters)
    member = (await db.execute(stmt)).scalars().first()
    if member is None:
        raise HTTPException(status_code=400, detail="Team member not found")
    return member


def _msg_payload(msg: ConversationMessage, sender: TeamMember | None) -> dict:
    return {
        "id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "thread_id": str(msg.thread_id) if msg.thread_id else None,
        "reply_count": msg.reply_count,
        "last_reply_at": msg.last_reply_at.isoformat() if msg.last_reply_at else None,
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
    exclude_ids: set[uuid.UUID] | None = None,
) -> None:
    """conversation:message → 전 참여자 SSE dispatch + Event INSERT.

    exclude_ids: SSE 발송에서 제외할 member_id 집합 (Discord 수신자 등).
    """
    if not conversation.project_id:
        return

    payload = _msg_payload(msg, sender)

    # 참여자 조회
    rows = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation.id)
    )).all()
    participant_ids = {r[0] for r in rows} - {sender.id} - (exclude_ids or set())

    if not participant_ids:
        return

    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participant_ids))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    events_to_push: list[tuple[str, Event]] = []
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
        events_to_push.append((str(pid), event))

    # flush 후 event.id 확보 → event_id 포함 push (dedup 동작 보장)
    await db.flush()
    for pid_str, event in events_to_push:
        _push_to_agent(pid_str, {"event_id": str(event.id), "event_type": "conversation:message", **payload})


async def _dispatch_mention_events(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: TeamMember,
    mention_targets: set[uuid.UUID],
) -> None:
    """AC1: 멘션 대상에게 conversation:mention SSE 발송 (participant 여부 무관)."""
    if not conversation.project_id or not mention_targets:
        return

    payload = _msg_payload(msg, sender)
    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(mention_targets))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    events_to_push: list[tuple[str, Event]] = []
    for pid in mention_targets:
        m_type = member_type_map.get(pid, "human")
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation:mention",
            source_entity_type="conversation_message",
            source_entity_id=msg.id,
            sender_id=sender.id,
            recipient_id=pid,
            recipient_type=m_type,
            payload=payload,
            status="pending",
        )
        db.add(event)
        events_to_push.append((str(pid), event))

    await db.flush()
    for pid_str, event in events_to_push:
        _push_to_agent(pid_str, {"event_id": str(event.id), "event_type": "conversation:mention", **payload})


async def _dispatch_discord_outbound(
    message_id: uuid.UUID,
    org_id: uuid.UUID,
) -> None:
    """Discord 아웃바운드 (AC9~11).

    ChannelRouter가 discord 선택한 수신자 → webhook_configs Discord endpoint 발송.
    Discord 선택 시 SSE 동시 발송 금지 (AC10).
    Discord endpoint 미설정 시 sse fallback (AC11).
    """
    from app.core.database import async_session_factory
    from app.services.channel_router import ChannelRouterError, route_message
    from sqlalchemy import select

    async with async_session_factory() as db:
        try:
            decisions = await route_message(message_id, db)
        except ChannelRouterError:
            logger.exception("ChannelRouter failed message_id=%s — skipping discord outbound", message_id)
            return

        discord_members = [d for d in decisions if d.channel == "discord"]
        if not discord_members:
            return

        import httpx
        for decision in discord_members:
            # discord channel WebhookConfig 조회
            wh = (await db.execute(
                select(WebhookConfig).where(
                    WebhookConfig.member_id == decision.member_id,
                    WebhookConfig.channel == "discord",
                    WebhookConfig.is_active.is_(True),
                )
            )).scalars().first()

            if wh is None:
                # AC11: Discord endpoint 미설정 → sse fallback (SSE는 이미 _dispatch_conversation_event에서 처리)
                logger.info(
                    "Discord endpoint not configured for member %s — SSE fallback already dispatched",
                    decision.member_id,
                )
                continue

            # Discord URL이면 content/embeds 포맷, 아니면 generic JSON
            is_discord_url = (
                "discord.com/api/webhooks" in wh.url
                or "discordapp.com/api/webhooks" in wh.url
            )
            content_text = f"[conversation:message] message_id: {message_id}"
            if is_discord_url:
                discord_payload: dict = {"content": content_text}
            else:
                discord_payload = {"event_type": "conversation.message_created", "message_id": str(message_id)}

            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(wh.url, json=discord_payload)
            except Exception:
                logger.warning(
                    "Discord outbound failed member_id=%s url=%s", decision.member_id, wh.url, exc_info=True
                )


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CreateConversationRequest(BaseModel):
    type: str = "group"  # dm | group
    title: str | None = None
    participant_ids: list[uuid.UUID]
    project_id: uuid.UUID


class SendMessageRequest(BaseModel):
    content: str
    mentioned_ids: list[uuid.UUID] = []
    thread_id: uuid.UUID | None = None


class UpdateStatusRequest(BaseModel):
    status: str  # open | resolved


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
    sender = await _resolve_member(auth, org_id, db, project_id=body.project_id)

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
    include_agent_conversations: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations — 최근 메시지 미리보기 + 참여 대화 목록."""
    sender = await _resolve_member(auth, org_id, db, project_id=project_id)

    # AC5: include_agent_conversations는 owner/admin만 허용
    if include_agent_conversations and sender.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only owner/admin can view agent conversations.")

    conv_ids_result = await db.execute(
        select(ConversationParticipant.conversation_id).where(
            ConversationParticipant.member_id == sender.id
        )
    )
    conv_ids = set(r[0] for r in conv_ids_result.all())

    # AC1/2: project 내 agent type member가 participant인 conversation 포함
    if include_agent_conversations:
        agent_ids_result = await db.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == project_id,
                TeamMember.org_id == org_id,
                TeamMember.type == "agent",
                TeamMember.is_active.is_(True),
            )
        )
        agent_ids = [r[0] for r in agent_ids_result.all()]
        if agent_ids:
            agent_conv_result = await db.execute(
                select(ConversationParticipant.conversation_id).where(
                    ConversationParticipant.member_id.in_(agent_ids)
                )
            )
            conv_ids.update(r[0] for r in agent_conv_result.all())

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
            "status": conv.status,
            "resolved_by": str(conv.resolved_by) if conv.resolved_by else None,
            "resolved_at": conv.resolved_at.isoformat() if conv.resolved_at else None,
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
    thread_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations/{id}/messages — cursor 기반 페이지네이션.

    thread_id 미지정: top-level 메시지만 반환 (thread_id IS NULL).
    thread_id 지정: 해당 thread의 reply 목록 반환.
    """
    conv_project_id = (await db.execute(
        select(Conversation.project_id).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv_project_id is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv_project_id)

    # 참여자 검증 — owner/admin은 에이전트 대화 열람 허용
    if sender.role not in ("owner", "admin"):
        participant = (await db.execute(
            select(ConversationParticipant.id).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.member_id == sender.id,
            )
        )).scalar_one_or_none()
        if participant is None:
            raise HTTPException(status_code=403, detail="Not a participant")

    if thread_id is None:
        thread_filter = ConversationMessage.thread_id.is_(None)
    else:
        thread_filter = ConversationMessage.thread_id == thread_id

    stmt = (
        select(ConversationMessage)
        .where(ConversationMessage.conversation_id == conversation_id, thread_filter)
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
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

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
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/conversations/{id}/messages — 전송 + SSE dispatch."""
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # CB-S2: DM + 비참여자 멘션 → 자동 그룹 conversation fork (AC1, AC2)
    fork_info: dict | None = None
    if conv.type == "dm" and body.mentioned_ids:
        # cross-org 차단: mentioned_ids를 현재 org 소속 member로 필터링
        valid_member_ids = set((await db.execute(
            select(TeamMember.id).where(
                TeamMember.id.in_(body.mentioned_ids),
                TeamMember.org_id == org_id,
            )
        )).scalars().all())

        current_participant_ids = set((await db.execute(
            select(ConversationParticipant.member_id)
            .where(ConversationParticipant.conversation_id == conversation_id)
        )).scalars().all())

        non_participants = [mid for mid in valid_member_ids if mid not in current_participant_ids]
        if non_participants:
            fork_conv_id = uuid.uuid4()
            fork_conv = Conversation(
                id=fork_conv_id,
                project_id=conv.project_id,
                org_id=org_id,
                type="group",
                created_by=sender.id,
            )
            db.add(fork_conv)
            await db.flush()

            all_participant_ids = current_participant_ids | valid_member_ids
            for mid in all_participant_ids:
                db.add(ConversationParticipant(conversation_id=fork_conv_id, member_id=mid))

            fork_info = {"forked_conversation_id": str(fork_conv_id)}
            # 메시지를 fork된 group conversation에 저장
            conversation_id = fork_conv_id
            conv = fork_conv

    # thread_id 유효성 검증 — 같은 conversation의 top-level message만 허용
    root_msg: ConversationMessage | None = None
    if body.thread_id is not None:
        root_msg = (await db.execute(
            select(ConversationMessage).where(
                ConversationMessage.id == body.thread_id,
                ConversationMessage.conversation_id == conversation_id,
            )
        )).scalar_one_or_none()
        if root_msg is None:
            raise HTTPException(status_code=400, detail="Thread root not found in this conversation")
        if root_msg.thread_id is not None:
            raise HTTPException(status_code=400, detail="Cannot reply to a reply (single-level thread only)")

    msg = ConversationMessage(
        conversation_id=conversation_id,
        sender_id=sender.id,
        content=body.content,
        mentioned_ids=body.mentioned_ids,
        thread_id=body.thread_id,
    )
    db.add(msg)

    # reply인 경우 root message의 reply_count / last_reply_at 원자 업데이트
    if root_msg is not None:
        await db.execute(
            update(ConversationMessage)
            .where(ConversationMessage.id == body.thread_id)
            .values(
                reply_count=ConversationMessage.reply_count + 1,
                last_reply_at=datetime.now(timezone.utc),
            )
        )

    await db.flush()

    # AC10: Discord 수신자 파악 → SSE dispatch에서 제외 (동일 db 세션, flush 완료 상태)
    discord_exclude_ids: set[uuid.UUID] = set()
    try:
        from app.services.channel_router import ChannelRouterError, route_message as _route
        decisions = await _route(msg.id, db)
        discord_exclude_ids = {d.member_id for d in decisions if d.channel == "discord"}
    except Exception:
        logger.warning("ChannelRouter pre-check failed message_id=%s — no SSE exclusion", msg.id)

    try:
        async with db.begin_nested():
            await _dispatch_conversation_event(db, conv, msg, org_id, sender, exclude_ids=discord_exclude_ids)
    except Exception:
        logger.exception("conversation event dispatch failed conversation_id=%s", conversation_id)

    # AC1: 멘션 대상에게 conversation:mention SSE 발송 (participant 여부 무관)
    if msg.mentioned_ids:
        mention_targets = set(msg.mentioned_ids) - {sender.id} - discord_exclude_ids
        if mention_targets:
            try:
                async with db.begin_nested():
                    await _dispatch_mention_events(db, conv, msg, org_id, sender, mention_targets)
            except Exception:
                logger.warning("mention event dispatch failed conversation_id=%s", conversation_id, exc_info=True)

    # conversation updated_at 갱신
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(msg)

    # webhook delivery BackgroundTask (AC1~8)
    from app.services.conversation_webhook import deliver_conversation_message_webhook
    background_tasks.add_task(
        deliver_conversation_message_webhook,
        message_id=msg.id,
        conversation_id=conversation_id,
        org_id=org_id,
        project_id=conv.project_id,
        sender_id=sender.id,
        thread_id=msg.thread_id,
        created_at=msg.created_at,
        mentioned_ids=list(msg.mentioned_ids) if msg.mentioned_ids else None,
        content=msg.content,
    )

    # Discord 아웃바운드 (AC9~11)
    background_tasks.add_task(
        _dispatch_discord_outbound,
        message_id=msg.id,
        org_id=org_id,
    )

    # S-C2: agent sender인 경우에만 message_sent 기록 (AC2, AC4, AC5, AC6)
    if sender.type == "agent":
        from app.services.activity_log import record_activity_bg
        background_tasks.add_task(
            record_activity_bg,
            org_id=org_id,
            action="message_sent",
            actor_id=sender.id,
            actor_type="agent",
            project_id=conv.project_id,
            entity_type="conversation",
            entity_id=conversation_id,
            context={
                "message_id": str(msg.id),
                "content_preview": msg.content[:80] if msg.content else "",
            },
        )

    response: dict = {"data": _msg_payload(msg, sender)}
    if fork_info:
        response["forked"] = True
        response["forked_conversation_id"] = fork_info["forked_conversation_id"]
    return response


@router.patch("/{conversation_id}/status", status_code=200)
async def update_conversation_status(
    conversation_id: uuid.UUID,
    body: UpdateStatusRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id}/status — open/resolved 전환."""
    if body.status not in ("open", "resolved"):
        raise HTTPException(status_code=400, detail="Invalid status. Must be 'open' or 'resolved'")

    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    requester = await _resolve_member(auth, org_id, db, project_id=conv.project_id)

    # 참여자 검증
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == requester.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    now = datetime.now(timezone.utc)
    if body.status == "resolved":
        conv.status = "resolved"
        conv.resolved_by = requester.id
        conv.resolved_at = now
    else:
        conv.status = "open"
        conv.resolved_by = None
        conv.resolved_at = None

    conv.updated_at = now
    await db.commit()
    await db.refresh(conv)

    return {
        "id": str(conv.id),
        "status": conv.status,
        "resolved_by": str(conv.resolved_by) if conv.resolved_by else None,
        "resolved_at": conv.resolved_at.isoformat() if conv.resolved_at else None,
    }
