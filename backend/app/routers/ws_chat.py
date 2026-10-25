"""E-FAKECHAT-INTEG:S1 — FastAPI WebSocket 채팅 허브.

WS /ws/chat/{agent_id}: 에이전트별 room 관리 + 브로드캐스트 + conversation_messages 영속화.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import and_, select

from sqlalchemy.exc import IntegrityError

from dataclasses import dataclass

from app.core.database import async_session_factory
from app.core.security import hash_token
from app.dependencies.auth import verify_access_token
from app.models.api_key import ApiKey
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant, MessageContentTooLong
from app.models.project import OrgMember
from app.models.team import TeamMember
from app.services.member_resolver import resolve_member_display_name
from app.services.conversation_auth import socket_can_read_conversation
from app.services.pg_pubsub import fire_and_forget
from app.services.project_auth import has_project_access
from app.services.stream_access import AccessRecheck, SeatRecheck, person_seat_revoked

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ws-chat", "Organization"])

# agent_id(str) → 연결된 WebSocket 집합
_rooms: dict[str, set[WebSocket]] = defaultdict(set)


@dataclass(frozen=True)
class _SocketIdent:
    """story #4775 — who a socket's owner is, for the one question a broadcast asks of every receiver: «may this one be sent a line of
    THAT conversation?» (`conversation_auth.socket_can_read_conversation` — REST's own rule). `member_id` is what the participants table
    holds, `access_user_id` what the project-access rule takes (a person's user id · an agent key's member id), `via_agent_key` picks the
    agent flavour of the admin-bypass atom."""
    member_id: uuid.UUID
    access_user_id: uuid.UUID
    org_id: uuid.UUID
    via_agent_key: bool


# socket → its owner. A socket without an entry is never sent a conversation line (nothing is assumed about a socket nobody vouched for).
_idents: dict[WebSocket, _SocketIdent] = {}


@dataclass(frozen=True)
class _CallerIdentity:
    """#2216: owner-floor 휴먼(team_members뷰에 행 없음)용 최소 caller 신원 — .id/.org_id만 담는다.
    TeamMember와 duck-type 호환(caller.id/caller.org_id로만 소비됨). story #4418 — 방송의 보낸 사람
    이름은 caller 객체에서 읽지 않고 `resolve_member_display_name`으로 해소한다(이 객체엔 이름이 없어
    `caller.name`이 AttributeError로 방송을 죽이고 보낸 사람 소켓까지 끊었다)."""
    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID | None = None  # story #4775 — the person's user id (what the project-access rule takes); None only where unknown


def _access_identity(caller: "TeamMember | _CallerIdentity", *, via_key: bool) -> tuple[uuid.UUID, bool]:
    """story #4775 — (the id `has_project_access` takes, whether the socket/route came in by an agent key): a person's user id (a
    `TeamMember` row of a person carries it, the owner-floor identity carries it); an agent key's member id."""
    # a person's key is still the person (`TeamMember.user_id`); an agent has no user id, its member id is what the rule takes
    return (getattr(caller, "user_id", None) or caller.id), via_key


async def _reachable_projects(agent_id: uuid.UUID, org_id: uuid.UUID, access_user_id: uuid.UUID) -> list[uuid.UUID]:
    """story #4775 AC4 — the projects this agent works in that the caller reaches (the one project-access rule REST uses), lowest id first.
    Empty = the caller has no way to this agent."""
    async with async_session_factory() as db:
        project_ids = (await db.execute(
            select(TeamMember.project_id)
            .where(TeamMember.id == agent_id, TeamMember.type == "agent", TeamMember.is_active.is_(True))
            .order_by(TeamMember.project_id)
        )).scalars().all()
        reachable: list[uuid.UUID] = []
        for pid in project_ids:
            if pid not in reachable and await has_project_access(db, access_user_id, pid, org_id):
                reachable.append(pid)
        return reachable


async def _authenticate(api_key: str | None, token: str | None, org_id: uuid.UUID | None = None) -> TeamMember | _CallerIdentity | None:
    """Query param API Key 또는 JWT로 TeamMember 반환. 실패 시 None.

    story #4774: a person who is in more than one organization has a `TeamMember` row per organization, and `.first()` without an ordering picked any of them — the socket's
    identity was another organization's one run to run (a 4003 «forbidden» on the wrong pick). With `org_id` (the agent's organization, known only after the agent is read) the
    person's identity IN THAT organization is returned (None if they have none); without it the pick is ordered (lowest organization id, then project id)."""
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
            # story 4725 (Mirko 6228236239): signature · type · subject · the per-user cut-off in ONE place
            try:
                payload = await verify_access_token(token, db)
            except HTTPException:
                return None
            user_id = payload["sub"]
            try:
                uid = uuid.UUID(user_id)
            except ValueError:
                return None
            tm_query = select(TeamMember).where(TeamMember.user_id == uid).where(TeamMember.is_active.is_(True))
            if org_id is not None:
                tm_query = tm_query.where(TeamMember.org_id == org_id)
            tm = (await db.execute(tm_query.order_by(TeamMember.org_id, TeamMember.project_id))).scalars().first()
            if tm is not None:
                return tm
            # #2216: team_members뷰(members ⋈ project_access INNER JOIN)는 owner-floor
            # 휴먼(명시 project_access grant 없이 has_project_access의 admin_branch로만
            # 접근하는 org owner/admin)을 이 뷰에 행이 없다는 이유로 못 찾는다 — 그 결과
            # owner-floor는 WS 채팅에 아예 접속하지 못했다(Unauthorized). org_members
            # SSOT(filter_org_member_ids와 동일 축)로 폴백 — 이 라우터가 caller에서 실제로
            # 쓰는 필드(.id/.org_id)만 있으면 되므로 최소 dataclass로 충분(TeamMember 전체
            # 필드 불필요).
            om_query = select(OrgMember.id, OrgMember.org_id).where(OrgMember.user_id == uid, OrgMember.deleted_at.is_(None))
            if org_id is not None:
                om_query = om_query.where(OrgMember.org_id == org_id)
            om = (await db.execute(om_query.order_by(OrgMember.org_id))).first()
            return _CallerIdentity(id=om.id, org_id=om.org_id, user_id=uid) if om is not None else None

    return None


# story #4565 (Qadir ①) — how often an open socket with an agent key is rechecked even while it only listens (a socket that
# never sends must still drop once its key is revoked); module-level so a test can shorten it
_WS_ACCESS_RECHECK_SEC: float = 5.0


async def _api_key_id(api_key: str | None) -> uuid.UUID | None:
    """The id of the agent key this socket connected with (None for a JWT) — the recheck follows that one key."""
    if not (api_key and api_key.startswith("sk_live_")):
        return None
    async with async_session_factory() as db:
        return (await db.execute(select(ApiKey.id).where(ApiKey.key_hash == hash_token(api_key)))).scalar_one_or_none()


async def _close_when_revoked(websocket: WebSocket, access: AccessRecheck) -> None:
    """Watch an open socket: once its key is no longer allowed, close it (4001) — it then neither sends nor hears."""
    while True:
        await asyncio.sleep(_WS_ACCESS_RECHECK_SEC)
        if await access.due(0):
            await websocket.close(code=4001, reason="access_revoked")
            return


async def _get_or_create_conversation(
    agent_id: uuid.UUID,
    caller_id: uuid.UUID,
    org_id: uuid.UUID,
    default_project_id: uuid.UUID,
) -> uuid.UUID:
    """에이전트↔사용자 쌍의 DM conversation 조회 또는 생성. conversation.id 반환.

    2c457a06 true-routing: 기존 (agent, caller) DM 이 있으면 **그 conversation 의 project 를 그대로**
    쓴다(대화가 자기 project 스코프를 소유·임의 grant row 아님·[[Member-SSOT No team_member Coercion]]).
    신규 생성 시에만 default_project_id(멀티프로젝트 agent 의 deterministic default) 사용. 다중 DM
    (멀티룸 정책) 공존 시 최古(created_at)=canonical 결정적 선택.
    """
    async with async_session_factory() as db:
        # 에이전트가 참가한 conversation_id 서브쿼리
        agent_conv_ids = (
            select(ConversationParticipant.conversation_id)
            .where(ConversationParticipant.member_id == agent_id)
            .scalar_subquery()
        )
        # 두 멤버가 모두 참가한 DM conversation 조회 — project 필터 없이(기존 DM 의 project 가 곧 스코프).
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
                Conversation.status != "deleted",
            )
            .order_by(Conversation.created_at, Conversation.id)  # 다중 DM 공존 시 최古=canonical(결정적)
            .limit(1)
        )).scalar_one_or_none()

        if conv is None:
            conv = Conversation(
                org_id=org_id,
                project_id=default_project_id,  # 신규 DM 만 default project 로 스코프
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


async def _broadcast(room_key: str, payload: str, *, conversation_id: uuid.UUID) -> None:
    """Send `payload` — a line of conversation `conversation_id` — to the sockets of room `room_key` whose owner may read that conversation.

    story #4775: the room is per agent, but a line belongs to ONE conversation: before, every socket of the room got every line of every
    DM the agent is in (REST refused the same people with 404/403 — only the socket leaked). One judgment per distinct owner in the room (REST's
    own rule — `socket_can_read_conversation`), then the send; a socket nobody vouched for, or an owner who cannot be judged, gets nothing.
    """
    sockets = list(_rooms.get(room_key, ()))
    if not sockets:
        return
    idents = {_idents[ws] for ws in sockets if ws in _idents}
    # story #4774: a PERSON whose seat in the organization has ended is not sent this line — their socket is closed instead (4001 access_revoked), the same judgement
    # the request authentication makes (`person_seat_revoked`, one indexed read per distinct person in the room). An agent key's socket keeps its own key recheck.
    seat_ended: set[_SocketIdent] = set()
    for ident in idents:
        if not ident.via_agent_key and await person_seat_revoked(ident.access_user_id, ident.org_id):
            seat_ended.add(ident)
    idents -= seat_ended
    allowed: set[_SocketIdent] = set()
    if idents:
        async with async_session_factory() as db:
            for ident in idents:
                if await socket_can_read_conversation(
                    db, conversation_id, ident.org_id,
                    member_id=ident.member_id, access_user_id=ident.access_user_id, via_agent_key=ident.via_agent_key,
                ):
                    allowed.add(ident)
    dead: set[WebSocket] = set()
    for ws in sockets:
        ident = _idents.get(ws)
        if ident is not None and ident in seat_ended:
            dead.add(ws)
            try:
                await ws.close(code=4001, reason="access_revoked")
            except Exception:  # noqa: BLE001 — already closing
                logger.debug("ws_chat: close after seat ended failed room=%s", room_key, exc_info=True)
            continue
        if ident is None or ident not in allowed:
            continue
        try:
            await ws.send_text(payload)
        except Exception as exc:  # noqa: BLE001 — one receiver failing must not stop the others (story #4418)
            logger.warning("ws_chat: broadcast send failed room=%s error=%s", room_key, type(exc).__name__)
            dead.add(ws)
    if dead and room_key in _rooms:
        _rooms[room_key] -= dead
        if not _rooms[room_key]:
            _rooms.pop(room_key, None)
        for ws in dead:
            _idents.pop(ws, None)


def _parse_incoming(raw: str) -> tuple[str, str | None]:
    """A socket's line: plain text, or {"content": "...", "conversation_id": "..."} → (content, the conversation it names or None)."""
    try:
        data = json.loads(raw)
        content = data.get("content", "").strip()
        named = data.get("conversation_id")
        return content, (str(named) if named is not None else None)
    except (ValueError, AttributeError):
        return raw.strip(), None


async def _agent_answer_target(agent_id: uuid.UUID, org_id: uuid.UUID, named: str | None) -> tuple[uuid.UUID | None, str | None]:
    """story #4775 AC3 — where an answer sent through the AGENT'S OWN socket goes: the conversation it names, if the agent is in it; with
    none named, the agent's one DM when it has exactly one; otherwise nowhere — an error the agent's client sees (`conversation_id_required`
    · `conversation_not_found`). Never «the agent's oldest DM» (that put an answer into whoever's DM came first)."""
    async with async_session_factory() as db:
        in_conv = and_(
            ConversationParticipant.conversation_id == Conversation.id, ConversationParticipant.member_id == agent_id,
        )
        if named is not None:
            try:
                wanted = uuid.UUID(named)
            except ValueError:
                return None, "conversation_not_found"
            found = (await db.execute(
                select(Conversation.id).join(ConversationParticipant, in_conv)
                .where(Conversation.id == wanted, Conversation.org_id == org_id, Conversation.status != "deleted")
            )).scalar_one_or_none()
            return (found, None) if found is not None else (None, "conversation_not_found")
        dms = (await db.execute(
            select(Conversation.id).join(ConversationParticipant, in_conv)
            .where(Conversation.type == "dm", Conversation.org_id == org_id, Conversation.status != "deleted")
            .order_by(Conversation.created_at, Conversation.id).limit(2)
        )).scalars().all()
        return (dms[0], None) if len(dms) == 1 else (None, "conversation_id_required")


@router.websocket("/ws/chat/{agent_id}")
async def ws_chat_hub(
    websocket: WebSocket,
    agent_id: uuid.UUID,
    api_key: str | None = Query(default=None),
    token: str | None = Query(default=None),
) -> None:
    """WS /ws/chat/{agent_id} — 에이전트별 room 채팅 허브.

    인증: ?api_key=sk_live_... 또는 ?token=<jwt>
    수신 형식: 평문 text 또는 {"content": "...", "conversation_id": "..."}
    송신 형식: {"id": "...", "conversation_id": "...", "sender_id": "...", "sender_name": "...", "content": "...", "ts": "..."}

    story #4775 — the room is per agent but a line belongs to ONE conversation: every line is sent only to the sockets whose owner may read
    that conversation (REST's rule), the connect gate is the agent's project (not «same organization» alone), and an answer sent through
    the agent's own socket goes to the conversation it names (`conversation_id`) — with none named, to its only DM; else an error.
    """
    caller = await _authenticate(api_key, token)
    if caller is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="Unauthorized")
        return
    access_user_id, via_agent_key = _access_identity(caller, via_key=bool(api_key and api_key.startswith("sk_live_")))

    await websocket.accept()
    room_key = str(agent_id)
    logger.info("ws_chat: connected agent_id=%s caller=%s", agent_id, caller.id)

    # agent의 org_id/project_id 조회 (room 초기화용) — type='agent' 한정
    # team_members 는 projection VIEW — 멀티프로젝트 grant 면 같은 agent_id 가 N 행이라 무필터
    # scalar_one_or_none 은 MultipleResultsFound 로 깨진다. 신규 DM 의 project 는 아래에서 «이 사람이 닿는 agent 프로젝트 중
    # 최저 id» 로 정한다(story #4775 — 전엔 agent 의 최저 project: 그 프로젝트에 권한 없는 사람의 DM 이 REST 로는 403 인 방이 됐다).
    # ⚠️ known-limitation: 멀티프로젝트 agent 의 «신규» DM 은 여전히 한 프로젝트(이제 «이 사람이 닿는 최저 project_id»)로 스코프 —
    #   진짜 라우팅(기존 (agent,caller) DM 우선조회 → 그 conversation 의 project)은 follow-up story.
    async with async_session_factory() as db:
        agent_member = (await db.execute(
            select(TeamMember).where(
                TeamMember.id == agent_id,
                TeamMember.type == "agent",
                TeamMember.is_active.is_(True),  # deactivated agent 는 DM room 비도달(정합)
            ).order_by(TeamMember.project_id).limit(1)
        )).scalar_one_or_none()

    if agent_member is None:
        await websocket.send_text(json.dumps({"error": "agent not found"}))
        await websocket.close(code=4004)
        return

    # story #4774: a person in several organizations — their identity is the one IN THE AGENT'S organization (not whichever row came first)
    if agent_member.org_id != caller.org_id and not (api_key and api_key.startswith("sk_live_")):
        in_agent_org = await _authenticate(api_key, token, org_id=agent_member.org_id)
        if in_agent_org is not None:
            caller = in_agent_org
            access_user_id, via_agent_key = _access_identity(caller, via_key=False)

    # org 교차 검증 — caller가 agent와 동일 org 소속인지 확인
    if agent_member.org_id != caller.org_id:
        await websocket.send_text(json.dumps({"error": "forbidden"}))
        await websocket.close(code=4003, reason="Forbidden")
        return

    # story #4775 AC4 — the connect gate is not «same organization» alone: a person (or another agent) reaches this agent's room only through
    # a project the agent works in (the one project-access rule REST uses). The agent's OWN socket is its own room.
    own_socket = caller.id == agent_id
    default_project_id = agent_member.project_id
    if not own_socket:
        reachable = await _reachable_projects(agent_id, agent_member.org_id, access_user_id)
        if not reachable:
            await websocket.send_text(json.dumps({"error": "forbidden"}))
            await websocket.close(code=4003, reason="Forbidden")
            return
        default_project_id = reachable[0]

    # story #4565 (Qadir ①): an agent key revoked after this socket opened (its agent moved to another computer by a setup ·
    # a device disconnected) ends the socket — checked before each message it sends is kept, and on a timer while it listens
    key_id = await _api_key_id(api_key)
    # story #4774: a PERSON's socket (a JWT) has no key to revoke but it has a seat — asked on the timer below, before each message it sends is kept, and before each line
    # that is delivered to it (`_broadcast`): the same judgement the request authentication makes, so a removal / organization delete / account deletion ends the socket.
    access = AccessRecheck(key_id, caller.id, agent_only=False) if key_id else (None if via_agent_key else SeatRecheck(access_user_id, caller.org_id))
    # held by pg_pubsub's own set (never collected early) and kept here to cancel when the socket ends
    watcher = fire_and_forget(_close_when_revoked(websocket, access)) if access else None
    try:
        # story #4418 (Qadir 01a0eb42) — inside the try: if either fails, the `finally` below takes the socket out of the room
        conv_id: uuid.UUID | None = None
        if not own_socket:
            conv_id = await _get_or_create_conversation(
                agent_id, caller.id, agent_member.org_id, default_project_id
            )
        # story #4418 — the sender's name once per connection, the same way for every caller kind: TeamMember.name, or the
        # owner-floor person's users.display_name, or None (#3747 contract — no email, no id string).
        async with async_session_factory() as db:
            sender_name = await resolve_member_display_name(caller.id, caller.org_id, db)

        # the socket enters the room only now — after every gate (before, a refused socket sat in the room until it was closed)
        _idents[websocket] = _SocketIdent(
            member_id=caller.id, access_user_id=access_user_id, org_id=caller.org_id, via_agent_key=via_agent_key,
        )
        _rooms[room_key].add(websocket)

        while True:
            raw = await websocket.receive_text()
            # 평문 또는 {"content": "...", "conversation_id": "..."} 모두 허용
            content, named_conversation = _parse_incoming(raw)
            if not content:
                continue
            if access is not None and await access.due(0):
                await websocket.close(code=4001, reason="access_revoked")
                return  # nothing kept from a key (or a person) that is no longer allowed

            # story #4775 AC3 — where this line is kept: a person's (or another agent's) line goes to ITS DM with this agent;
            # the agent's own answer goes to the conversation it names. A conversation a person names is ignored (their socket is
            # bound to their own DM).
            target = conv_id
            if own_socket:
                target, refusal = await _agent_answer_target(agent_id, agent_member.org_id, named_conversation)
                if target is None:
                    await websocket.send_text(json.dumps({"error": {"code": refusal}}))
                    continue
            assert target is not None

            # story #4775 (codex round 1) — the same question REST asks before it keeps a line, asked of THIS socket's owner for THIS
            # conversation on every line: a person whose project access was removed after they connected (or an agent that lost its) is
            # not kept — the socket ends (4003). Nothing is saved first.
            async with async_session_factory() as db:
                still_allowed = await socket_can_read_conversation(
                    db, target, caller.org_id,
                    member_id=caller.id, access_user_id=access_user_id, via_agent_key=via_agent_key,
                )
            if not still_allowed:
                await websocket.send_text(json.dumps({"error": "forbidden"}))
                await websocket.close(code=4003, reason="Forbidden")
                return

            # conversation_messages 영속화
            async with async_session_factory() as db:
                try:
                    msg = ConversationMessage(
                        conversation_id=target,
                        sender_id=caller.id,
                        content=content,
                        mentioned_ids=[],
                    )
                except MessageContentTooLong as e:
                    # story #4605: that message is refused (the API's 422 in this socket's words) — the socket stays open
                    await websocket.send_text(json.dumps({"error": {"code": "message_too_long", "limit": e.limit, "got": e.got}}))
                    continue
                db.add(msg)
                await db.commit()
                await db.refresh(msg)

            payload = json.dumps({
                "id": str(msg.id),
                "conversation_id": str(target),
                "sender_id": str(caller.id),
                "sender_name": sender_name,
                "content": content,
                "ts": msg.created_at.isoformat(),
            })
            # story #4418 — the message is saved; a failure while broadcasting it must not close the sender's socket
            # (before, the exception left the handler and the connection dropped on every message). It is logged, and
            # the sender still gets the saved message back as its confirmation.
            try:
                await _broadcast(room_key, payload, conversation_id=target)
            except WebSocketDisconnect:
                raise  # a disconnect is not a broadcast failure: the handler's own cleanup below (Qadir 01a0eb42)
            except Exception:  # noqa: BLE001
                logger.error(
                    "ws_chat: broadcast failed after save agent_id=%s message_id=%s", agent_id, msg.id, exc_info=True,
                )
                # only the sender's OWN just-saved line goes back to the sender (it passed the check above for this very line)
                await websocket.send_text(payload)

    except WebSocketDisconnect:
        logger.info("ws_chat: disconnected agent_id=%s caller=%s", agent_id, caller.id)
    finally:
        if watcher is not None:
            watcher.cancel()
        _idents.pop(websocket, None)
        if room_key in _rooms:
            _rooms[room_key].discard(websocket)
            if not _rooms[room_key]:
                _rooms.pop(room_key, None)
