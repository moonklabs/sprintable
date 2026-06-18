"""E-FAKECHAT-INTEG:S1 — FastAPI WebSocket 채팅 허브.

WS /ws/chat/{agent_id}: 에이전트별 room 관리 + 브로드캐스트 + conversation_messages 영속화.
"""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import and_, select

from sqlalchemy.exc import IntegrityError

from app.core.database import async_session_factory
from app.core.security import JWTError, decode_jwt, hash_token
from app.models.api_key import ApiKey
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.team import TeamMember

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ws-chat"])

# agent_id(str) → 연결된 WebSocket 집합
_rooms: dict[str, set[WebSocket]] = defaultdict(set)


async def _authenticate(api_key: str | None, token: str | None) -> TeamMember | None:
    """Query param API Key 또는 JWT로 TeamMember 반환. 실패 시 None."""
    now = datetime.now(timezone.utc)
    async with async_session_factory() as db:
        if api_key and api_key.startswith("sk_live_"):
            key_hash = hash_token(api_key)
            ak = (await db.execute(
                select(ApiKey)
                .where(ApiKey.key_hash == key_hash)
                .where(ApiKey.revoked_at.is_(None))
                .where((ApiKey.expires_at.is_(None)) | (ApiKey.expires_at > now))
            )).scalar_one_or_none()
            if not ak:
                return None
            # team_members 는 projection VIEW — 멀티프로젝트 grant 면 같은 id 가 N 행. 여기선 auth
            # identity(.id/.org_id·동형) 해소라 .limit(1) 로 MultipleResultsFound 회피(아무 행 OK).
            return (await db.execute(
                select(TeamMember)
                .where(TeamMember.id == ak.team_member_id)
                .where(TeamMember.is_active.is_(True))
                .limit(1)
            )).scalar_one_or_none()

        if token:
            try:
                payload = decode_jwt(token)
            except JWTError:
                return None
            user_id = payload.get("sub")
            if not user_id:
                return None
            try:
                uid = uuid.UUID(user_id)
            except ValueError:
                return None
            return (await db.execute(
                select(TeamMember)
                .where(TeamMember.user_id == uid)
                .where(TeamMember.is_active.is_(True))
            )).scalars().first()

    return None


async def _get_or_create_conversation(
    agent_id: uuid.UUID,
    caller_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
) -> uuid.UUID:
    """에이전트↔사용자 쌍의 DM conversation 조회 또는 생성. conversation.id 반환."""
    async with async_session_factory() as db:
        # 에이전트가 참가한 conversation_id 서브쿼리
        agent_conv_ids = (
            select(ConversationParticipant.conversation_id)
            .where(ConversationParticipant.member_id == agent_id)
            .scalar_subquery()
        )
        # 두 멤버가 모두 참가한 DM conversation 조회
        conv = (await db.execute(
            select(Conversation)
            .join(ConversationParticipant, and_(
                ConversationParticipant.conversation_id == Conversation.id,
                ConversationParticipant.member_id == caller_id,
            ))
            .where(
                Conversation.id.in_(agent_conv_ids),
                Conversation.type == "dm",
                Conversation.org_id == org_id,
                Conversation.project_id == project_id,
                Conversation.status != "deleted",
            )
            .limit(1)
        )).scalar_one_or_none()

        if conv is None:
            conv = Conversation(
                org_id=org_id,
                project_id=project_id,
                type="dm",
                title=None,
                created_by=agent_id,
            )
            db.add(conv)
            await db.flush()
            db.add(ConversationParticipant(conversation_id=conv.id, member_id=agent_id))
            db.add(ConversationParticipant(conversation_id=conv.id, member_id=caller_id))
            await db.commit()
            await db.refresh(conv)

        return conv.id


async def _broadcast(room_key: str, payload: str) -> None:
    dead: set[WebSocket] = set()
    for ws in list(_rooms[room_key]):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _rooms[room_key] -= dead
    if not _rooms[room_key]:
        _rooms.pop(room_key, None)


@router.websocket("/ws/chat/{agent_id}")
async def ws_chat_hub(
    websocket: WebSocket,
    agent_id: uuid.UUID,
    api_key: str | None = Query(default=None),
    token: str | None = Query(default=None),
) -> None:
    """WS /ws/chat/{agent_id} — 에이전트별 room 채팅 허브.

    인증: ?api_key=sk_live_... 또는 ?token=<jwt>
    수신 형식: 평문 text 또는 {"content": "..."}
    송신 형식: {"id": "...", "sender_id": "...", "sender_name": "...", "content": "...", "ts": "..."}
    """
    caller = await _authenticate(api_key, token)
    if caller is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    room_key = str(agent_id)
    _rooms[room_key].add(websocket)
    logger.info("ws_chat: connected agent_id=%s caller=%s", agent_id, caller.id)

    # agent의 org_id/project_id 조회 (room 초기화용) — type='agent' 한정
    async with async_session_factory() as db:
        agent_member = (await db.execute(
            select(TeamMember).where(
                TeamMember.id == agent_id,
                TeamMember.type == "agent",
            )
        )).scalar_one_or_none()

    if agent_member is None:
        await websocket.send_text(json.dumps({"error": "agent not found"}))
        await websocket.close(code=4004)
        _rooms[room_key].discard(websocket)
        return

    # org 교차 검증 — caller가 agent와 동일 org 소속인지 확인
    if agent_member.org_id != caller.org_id:
        await websocket.send_text(json.dumps({"error": "forbidden"}))
        await websocket.close(code=4003, reason="Forbidden")
        _rooms[room_key].discard(websocket)
        return

    conv_id = await _get_or_create_conversation(
        agent_id, caller.id, agent_member.org_id, agent_member.project_id
    )

    try:
        while True:
            raw = await websocket.receive_text()
            # 평문 또는 {"content": "..."} 모두 허용
            try:
                content = json.loads(raw).get("content", "").strip()
            except (ValueError, AttributeError):
                content = raw.strip()
            if not content:
                continue

            # conversation_messages 영속화
            async with async_session_factory() as db:
                msg = ConversationMessage(
                    conversation_id=conv_id,
                    sender_id=caller.id,
                    content=content,
                    mentioned_ids=[],
                )
                db.add(msg)
                await db.commit()
                await db.refresh(msg)

            payload = json.dumps({
                "id": str(msg.id),
                "conversation_id": str(conv_id),
                "sender_id": str(caller.id),
                "sender_name": caller.name,
                "content": content,
                "ts": msg.created_at.isoformat(),
            })
            await _broadcast(room_key, payload)

    except WebSocketDisconnect:
        logger.info("ws_chat: disconnected agent_id=%s caller=%s", agent_id, caller.id)
    finally:
        _rooms[room_key].discard(websocket)
        if not _rooms[room_key]:
            _rooms.pop(room_key, None)
