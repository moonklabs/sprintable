"""E-EVENTBUS P7-A S37: conversations 테이블 + Chat API."""
from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.event import Event
from app.models.project import OrgMember
from app.models.team import AgentMessageAllowlist, TeamMember
from app.models.agent_deployment import AgentAuditLog
from app.models.webhook_config import WebhookConfig
from app.routers.events import _push_to_agent, publish_event
from app.services import chat_presence
from app.services.agent_runtime import supports_deterministic_command
from app.services.command_classifier import classify_command
from app.services.event_seq import assign_recipient_seq
from app.services.member_resolver import (
    ResolvedMember,
    filter_org_member_ids,
    lookup_members_by_ids,
    resolve_member,
    resolve_member_identity,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/conversations", tags=["conversations"])


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _enforce_agent_creator_policy(
    sender: "ResolvedMember | TeamMember",
    participant_ids: list[uuid.UUID],
    db: AsyncSession,
) -> None:
    """⭐ 불변식: 휴먼↔에이전트 대화 — 각 에이전트의 creator가 참가자(sender ∪ participant_ids)에 있어야.

    전제: 에이전트 없거나 휴먼 없으면(에이전트↔에이전트) skip.
    """
    if not participant_ids:
        return

    all_ids = set(participant_ids) | {sender.id}

    # 에이전트 participant 조회
    agent_tms = (await db.execute(
        select(TeamMember).where(
            TeamMember.id.in_(all_ids),
            TeamMember.type == "agent",
        )
    )).scalars().all()
    if not agent_tms:
        return  # 에이전트 없음 → skip

    agent_ids = {a.id for a in agent_tms}
    non_agent_ids = all_ids - agent_ids
    if not non_agent_ids:
        return  # ⭐ 에이전트↔에이전트 → 게이팅 skip (팀 comms 불변·핵심 안전조건, E-MSG-POLICY S1 불변)

    # 휴먼 참가자 (member_id, user_id) 수집 — mode별 인가에 둘 다 필요
    humans: list[tuple[uuid.UUID, uuid.UUID | None]] = []
    sender_user_id = getattr(sender, "user_id", None)
    if sender.id in non_agent_ids:
        humans.append((sender.id, sender_user_id))

    remaining_ids = non_agent_ids - {sender.id}
    if remaining_ids:
        # TeamMember 조회
        tm_humans = (await db.execute(
            select(TeamMember).where(TeamMember.id.in_(remaining_ids))
        )).scalars().all()
        humans.extend((tm.id, tm.user_id) for tm in tm_humans)

        # OrgMember 조회 (grant-only 휴먼)
        tm_found_ids = {tm.id for tm in tm_humans}
        om_ids = remaining_ids - tm_found_ids
        if om_ids:
            oms = (await db.execute(
                select(OrgMember).where(OrgMember.id.in_(om_ids))
            )).scalars().all()
            humans.extend((om.id, om.user_id) for om in oms)

    human_user_ids: set[uuid.UUID] = {u for _, u in humans if u}

    # E-MSG-POLICY S1: 각 에이전트의 message_policy_mode 별 인가
    for agent_tm in agent_tms:
        mode = getattr(agent_tm, "message_policy_mode", None) or "creator_only"

        if mode == "org_wide":
            continue  # org 내 휴먼 전부 허용 (참가자는 이미 org-scoped) → 통과

        if mode == "list":
            allowed_ids = set((await db.execute(
                select(AgentMessageAllowlist.allowed_id).where(
                    AgentMessageAllowlist.agent_member_id == agent_tm.id
                )
            )).scalars().all())
            for member_id, user_id in humans:
                # creator는 모드 무관 항상 허용 (자기 에이전트 접근)
                is_creator = user_id is not None and user_id == agent_tm.created_by
                if member_id not in allowed_ids and not is_creator:
                    logger.warning(
                        "agent creator policy 403: agent_id=%s sender_id=%s reason=allowlist_miss member_id=%s",
                        agent_tm.id, sender.id, member_id,
                    )
                    raise HTTPException(
                        status_code=403,
                        detail="Member is not in this agent's message allowlist",
                    )
            continue

        # creator_only (default·기존 동작): 에이전트 creator가 참가자여야
        if agent_tm.created_by is None:
            logger.warning(
                "agent creator policy 403: agent_id=%s sender_id=%s reason=created_by_none",
                agent_tm.id, sender.id,
            )
            raise HTTPException(status_code=403, detail="Agent has no creator — conversation not allowed")
        if agent_tm.created_by not in human_user_ids:
            logger.warning(
                "agent creator policy 403: agent_id=%s sender_id=%s reason=creator_not_participant created_by=%s",
                agent_tm.id, sender.id, agent_tm.created_by,
            )
            raise HTTPException(status_code=403, detail="Agent's creator must be a participant in this conversation")


async def _resolve_member(
    auth: AuthContext,
    org_id: uuid.UUID,
    db: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> "ResolvedMember | TeamMember":
    """TeamMember 우선; grant-only 휴먼이면 ResolvedMember(org_member.id) 반환."""
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        tm = (await db.execute(select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id)))).scalars().first()
        if tm is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        return tm

    # JWT 휴먼: team_member 먼저 시도
    filters = [TeamMember.user_id == uuid.UUID(auth.user_id), TeamMember.org_id == org_id]
    if project_id is not None:
        filters.append(TeamMember.project_id == project_id)
    tm = (await db.execute(select(TeamMember).where(*filters))).scalars().first()
    if tm is not None:
        return tm

    # team_member 없음 (grant-only 휴먼) → org_member 경로
    return await resolve_member(auth, org_id, db, project_id=project_id)


async def _effective_org_role(
    auth: AuthContext, org_id: uuid.UUID, db: AsyncSession, sender: "ResolvedMember | TeamMember"
) -> str:
    """sender.role에 org owner/admin 상속(S-MBR-03). team_members 뷰는 **project role만** 주므로
    org owner/admin이 project-member로 나오는 갭(#1223 agent-view 게이트 ↔ 멤버-SSOT 뷰)을 보정 —
    /me effective-role과 일관(버그: org owner/admin이 agent-view 403). 에이전트(API키)는 org role
    무관이라 sender.role 그대로."""
    if sender.role in ("owner", "admin"):
        return sender.role
    if bool(auth.claims.get("app_metadata", {}).get("api_key_id")):
        return sender.role
    om_role = (await db.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == uuid.UUID(auth.user_id),
            OrgMember.deleted_at.is_(None),
        ).limit(1)
    )).scalar_one_or_none()
    return om_role if om_role in ("owner", "admin") else sender.role


async def _conversation_has_human_participant(conversation_id: uuid.UUID, db: AsyncSession) -> bool:
    """대화에 휴먼 참가자가 있으면 True(=private·admin 우회 금지).
    보수적: agent team_member로 확정 안 된 참가자는 human 간주(grant-only/미앵커 휴먼 포함)."""
    pids = (await db.execute(
        select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == conversation_id)
    )).scalars().all()
    if not pids:
        return False
    agent_ids = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(pids), TeamMember.type == "agent")
    )).scalars().all())
    return any(p not in agent_ids for p in pids)  # agent 확정 외 = human 보수적


async def _conversations_with_human_participant(conv_ids: list[uuid.UUID], db: AsyncSession) -> set[uuid.UUID]:
    """conv_ids 중 휴먼 참가자가 있는 conversation_id 집합(보수적·agent 확정 외 human)."""
    if not conv_ids:
        return set()
    rows = (await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id.in_(conv_ids))
    )).all()
    # member_id 중 agent 확정 집합
    all_mids = {m for _, m in rows}
    agent_ids = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(all_mids), TeamMember.type == "agent")
    )).scalars().all()) if all_mids else set()
    result: set[uuid.UUID] = set()
    for cid, mid in rows:
        if mid not in agent_ids:  # human 참가자 발견
            result.add(cid)
    return result


_SUMMARY_PREVIEW_MAX = 80


def _build_message_summary(content: str | None, sender_name: str | None, has_attachment: bool) -> str:
    """알림 카피용 사람-친화 summary (e2608901). 형식: "{발신자}: {내용 미리보기 80자}".

    notification-bell이 `payload.summary ?? event_type`로 렌더하므로, summary 미생성 시 raw
    이벤트명(`conversation.message_created`)이 노출됐다. 발신자+미리보기로 "무슨 일인지" 1초 노출.
    """
    name = sender_name or "Someone"
    preview = " ".join((content or "").split())  # 개행/연속공백 정규화
    if len(preview) > _SUMMARY_PREVIEW_MAX:
        preview = preview[:_SUMMARY_PREVIEW_MAX].rstrip() + "…"
    if not preview:
        preview = "📎" if has_attachment else ""
    return f"{name}: {preview}" if preview else name


def _msg_payload(msg: ConversationMessage, sender: "ResolvedMember | TeamMember | None") -> dict:
    attachments = msg.attachments if isinstance(msg.attachments, list) else []
    return {
        "id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "thread_id": str(msg.thread_id) if msg.thread_id else None,
        "reply_count": msg.reply_count,
        "last_reply_at": msg.last_reply_at.isoformat() if msg.last_reply_at else None,
        "content": msg.content,
        "mentioned_ids": [str(m) for m in (msg.mentioned_ids or [])],
        # E-FILE S1: 첨부 직렬화 (SSE + GET messages 공통). list 아니면 [](레거시/None/mock 안전).
        "attachments": attachments,
        "sender": {
            "id": str(sender.id),
            "name": sender.name,
            "type": sender.type,
        } if sender else None,
        # e2608901: 알림 카피 — raw event_type 대신 사람-친화 summary를 payload에 동봉.
        "summary": _build_message_summary(msg.content, sender.name if sender else None, bool(attachments)),
        "created_at": msg.created_at.isoformat(),
    }


async def _dispatch_conversation_event(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: "ResolvedMember | TeamMember",
    exclude_ids: set[uuid.UUID] | None = None,
) -> list[tuple[str, dict]]:
    """conversation:message → Event INSERT + flush. push 페이로드 반환 (commit 후 호출).

    exclude_ids: SSE 발송에서 제외할 member_id 집합 (Discord 수신자 등).
    반환값: [(pid_str, payload)] — db.commit() 완료 후 _push_to_agent() 호출용.
    """
    if not conversation.project_id:
        return []

    payload = _msg_payload(msg, sender)

    # 참여자 조회
    rows = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation.id)
    )).all()
    participant_ids = {r[0] for r in rows} - {sender.id} - (exclude_ids or set())

    if not participant_ids:
        return []

    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(participant_ids))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    events_to_push: list[tuple[str, Event]] = []
    for pid in sorted(participant_ids):  # deadlock 방지: 일관 락 순서
        m_type = member_type_map.get(pid, "human")
        event = Event(
            project_id=conversation.project_id,
            org_id=org_id,
            event_type="conversation.message_created",  # canonical (S-COMM-12)
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
        # 1aeecdde P2: agent recipient 에게 메시지가 dispatch = 답장 생성 시작 → working emit.
        # 그 agent 가 reply 를 보내면 send_message 에서 clear, 안 보내면 TTL 자동 소멸(ephemeral).
        if m_type == "agent":
            chat_presence.set_working(str(conversation.id), str(pid))

    # flush로 event.id 확보
    await db.flush()
    # per-recipient dense seq 발급 (agent recipient만)
    for pid_str, event in events_to_push:
        if member_type_map.get(event.recipient_id, "human") == "agent":
            await assign_recipient_seq(db, event)
    return [(pid_str, {"event_id": str(event.id), "event_type": "conversation.message_created", **payload,
                       "recipient_seq": event.recipient_seq})
            for pid_str, event in events_to_push]


async def _dispatch_mention_events(
    db: AsyncSession,
    conversation: Conversation,
    msg: ConversationMessage,
    org_id: uuid.UUID,
    sender: TeamMember,
    mention_targets: set[uuid.UUID],
) -> list[tuple[str, dict]]:
    """AC1: 멘션 대상에게 conversation:mention Event INSERT + flush. push 페이로드 반환 (commit 후 호출).

    반환값: [(pid_str, payload)] — db.commit() 완료 후 _push_to_agent() 호출용.
    """
    if not conversation.project_id or not mention_targets:
        return []

    payload = _msg_payload(msg, sender)
    member_rows = (await db.execute(
        select(TeamMember.id, TeamMember.type).where(TeamMember.id.in_(mention_targets))
    )).all()
    member_type_map = {r[0]: r[1] for r in member_rows}

    events_to_push: list[tuple[str, Event]] = []
    for pid in sorted(mention_targets):  # deadlock 방지: 일관 락 순서
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

    # flush로 event.id 확보
    await db.flush()
    for _, event in events_to_push:
        if member_type_map.get(event.recipient_id, "human") == "agent":
            await assign_recipient_seq(db, event)
    return [(pid_str, {"event_id": str(event.id), "event_type": "conversation:mention", **payload})
            for pid_str, event in events_to_push]


async def _command_capability_gate(
    db: AsyncSession,
    conv: Conversation,
    msg: ConversationMessage,
    sender: "ResolvedMember | TeamMember",
    org_id: uuid.UUID,
) -> tuple[set[uuid.UUID], list[dict]]:
    """E-CHAT-CMD S4: capability gate — 슬래시 커맨드를 미지원 런타임 에이전트에 주입하지 않는다.

    메시지가 command candidate(S3 classifier)면, conversation 의 에이전트 수신자 각각의
    runtime_type 을 capability registry(S1)로 조회한다. 결정적 커맨드 미지원(또는 runtime_type
    없음/unknown) 에이전트는 **주입 차단**(반환된 id 를 dispatch exclude 로 사용) + audit log
    `command_blocked_unsupported_runtime` 기록 + hint 생성. 지원 에이전트는 그대로 pass-through.

    비-command 메시지는 빈 결과 → 기존 경로 무영향(AC4 회귀). project_id 없는 conversation 은
    애초에 에이전트 dispatch 가 없어 게이트 무의미 → 빈 결과.

    반환: (blocked_agent_ids, hints) — hints 는 발신자에게 돌려줄 구조화 안내.
    """
    candidate = classify_command(msg.content)
    if candidate is None or not conv.project_id:
        return set(), []

    rows = (await db.execute(
        select(TeamMember.id, TeamMember.name, TeamMember.runtime_type)
        .join(ConversationParticipant, ConversationParticipant.member_id == TeamMember.id)
        .where(
            ConversationParticipant.conversation_id == conv.id,
            TeamMember.type == "agent",
            TeamMember.id != sender.id,
        )
    )).all()

    blocked: set[uuid.UUID] = set()
    hints: list[dict] = []
    for agent_id, agent_name, runtime_type in rows:
        if supports_deterministic_command(runtime_type):
            continue  # AC2: 지원 런타임 → pass-through(기존 dispatch)
        # AC3/AC4: 미지원(또는 runtime_type 없음/unknown) → 차단 + audit + hint
        blocked.add(agent_id)
        db.add(AgentAuditLog(
            org_id=org_id,
            project_id=conv.project_id,
            agent_id=agent_id,
            event_type="command_blocked_unsupported_runtime",
            severity="info",
            summary=f"'/{candidate.name}' blocked — runtime '{runtime_type or 'unset'}' lacks deterministic command support",
            payload={
                "command": candidate.name,
                "raw": candidate.raw,
                "runtime_type": runtime_type,
                "conversation_id": str(conv.id),
                "message_id": str(msg.id),
                "sender_id": str(sender.id),
            },
        ))
        hints.append({
            "agent_id": str(agent_id),
            "agent_name": agent_name,
            "runtime_type": runtime_type,
            "command": candidate.name,
            "reason": "unsupported_runtime",
        })

    if blocked:
        await db.flush()
    return blocked, hints


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


class ConversationResponse(BaseModel):
    """단독 conversation 메타. 03fe1663: 첨부 업로드 라우트가 path projectId를
    클라이언트 쿠키 대신 conversation.project_id로 server-side 도출하는 데 사용."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    type: str
    title: str | None = None
    status: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    # 270c87e6: caller의 알림 mute 상태(participant muted_at 기반) — FE mute 토글 초기 상태용(#1426).
    muted: bool = False


# E-FILE S1: 채팅 첨부. GCS 기록은 FE-proxy(uploadToGcs)가 처리하고 BE는 URL+메타만 저장.
_MAX_ATTACHMENTS = 10
_MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024  # 100MB (메타 sanity 상한)


class MessageAttachment(BaseModel):
    url: str           # FE-proxy가 GCS에 업로드한 객체 URL (https)
    name: str          # 원본 파일명
    content_type: str  # MIME
    size: int          # 바이트

    @field_validator("url")
    @classmethod
    def _validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("https://"):
            raise ValueError("attachment url must be an https:// URL")
        return v

    @field_validator("name", "content_type")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("size")
    @classmethod
    def _validate_size(cls, v: int) -> int:
        if v < 0:
            raise ValueError("size must be >= 0")
        if v > _MAX_ATTACHMENT_SIZE:
            raise ValueError(f"attachment too large (max {_MAX_ATTACHMENT_SIZE} bytes)")
        return v


class SendMessageRequest(BaseModel):
    content: str
    mentioned_ids: list[uuid.UUID] = []
    thread_id: uuid.UUID | None = None
    attachments: list[MessageAttachment] = []

    @field_validator("attachments")
    @classmethod
    def _limit_attachments(cls, v: list[MessageAttachment]) -> list[MessageAttachment]:
        if len(v) > _MAX_ATTACHMENTS:
            raise ValueError(f"too many attachments (max {_MAX_ATTACHMENTS})")
        return v


class UpdateStatusRequest(BaseModel):
    status: str  # open | resolved


class UpdateConversationRequest(BaseModel):
    # EF-S2 (db75ecd0) AC3: 방 title 사용자 편집. title 제공 시만 갱신(기본 생성 title 보존).
    title: str | None = None


class AddParticipantRequest(BaseModel):
    member_id: uuid.UUID


class MuteRequest(BaseModel):
    muted: bool


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

    # ⭐ 인가 불변식: 휴먼↔에이전트 대화 — 에이전트 creator 동석 필수
    await _enforce_agent_creator_policy(sender, body.participant_ids, db)

    # EF-S2 (db75ecd0): "기존방 다이렉트" 제거 — 동일 2인 pair여도 매 호출 신규 conversation 생성
    # (여러 conversation 공존·각 1주제·hermes 세션별 1방=1주제). 179db213 의 1-DM-per-pair
    # dedup + uq_conversations_dm_pair 정책 회귀(마이그 0111 에서 unique index drop).
    # 불변 보존: creator 동석/allow_list(_enforce_agent_creator_policy 위), 메시지 dedup(send_message·별개),
    # thread=스토리. dm_pair_key 컬럼은 2인 룸 태깅용으로 유지(non-unique·dedup 아님).
    all_members = sorted({sender.id, *body.participant_ids})
    is_dm = len(all_members) == 2
    dm_pair_key = "|".join(str(m) for m in all_members) if is_dm else None

    conv = Conversation(
        project_id=body.project_id,
        org_id=org_id,
        type=("dm" if is_dm else body.type),
        title=body.title,
        created_by=sender.id,
        dm_pair_key=dm_pair_key,
    )
    db.add(conv)
    try:
        await db.flush()
        for mid in all_members:
            db.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
        await db.commit()
    except IntegrityError:
        # dedup unique 제거 후엔 DM pair 레이스 충돌 없음 — 잔여 무결성 오류는 reuse 없이 전파.
        await db.rollback()
        raise
    await db.refresh(conv)
    return {"id": str(conv.id), "type": conv.type, "title": conv.title, "existing": False}


@router.get("")
async def list_conversations(
    project_id: uuid.UUID = Query(...),
    include_agent_conversations: bool = Query(default=False),
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/conversations — 최근 메시지 미리보기 + 참여 대화 목록."""
    sender = await _resolve_member(auth, org_id, db, project_id=project_id)

    # AC5: include_agent_conversations는 owner/admin만 허용 (org-effective role — project team_member
    # role이 낮아도 org owner/admin이면 상속·#1223↔SSOT뷰 갭 보정)
    if include_agent_conversations and await _effective_org_role(auth, org_id, db, sender) not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Only owner/admin can view agent conversations.")

    conv_ids_result = await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.muted_at).where(
            ConversationParticipant.member_id == sender.id
        )
    )
    _caller_rows = conv_ids_result.all()
    conv_ids = set(r.conversation_id for r in _caller_rows)
    # 270c87e6: caller의 대화별 mute 상태(FE 토글 초기 상태·#1426). admin-bypass로 추가되는
    # agent-only 대화는 caller가 참여자 아니라 자연히 False.
    caller_muted = {r.conversation_id: r.muted_at is not None for r in _caller_rows}

    # AC1/2 + #1262: admin-bypass는 **agent-only 대화로 한정**(사적 DM 프라이버시).
    # project 내 agent type member가 participant인 conversation 후보를 모으되,
    # 휴먼 참가 대화(=private)는 보수적 판별로 제외 — admin에게 추가 노출 금지.
    # (본인 참여 대화는 base conv_ids로 이미 포함되니 무관.)
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
            candidate_conv_ids = {r[0] for r in agent_conv_result.all()}
            human_convs = await _conversations_with_human_participant(list(candidate_conv_ids), db)
            conv_ids.update(candidate_conv_ids - human_convs)  # agent-only만 admin에게 추가

    if not conv_ids:
        return {"data": [], "total": 0, "limit": limit, "offset": offset}

    conv_filter = (
        Conversation.id.in_(conv_ids),
        Conversation.org_id == org_id,
        Conversation.project_id == project_id,
    )
    total = (await db.execute(
        select(func.count()).select_from(Conversation).where(*conv_filter)
    )).scalar_one()

    convs = (await db.execute(
        select(Conversation)
        .where(*conv_filter)
        .order_by(Conversation.updated_at.desc())
        .limit(limit).offset(offset)
    )).scalars().all()

    # participants 배치 조회 (N+1 방지)
    conv_id_list = [c.id for c in convs]
    p_rows = (await db.execute(
        select(ConversationParticipant.conversation_id, ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id.in_(conv_id_list))
    )).all()

    all_member_ids = {r.member_id for r in p_rows}
    resolved_map = await lookup_members_by_ids(all_member_ids, db) if all_member_ids else {}

    # E-CHAT-CMD S8b: participant 의 runtime_type 노출(team_members 뷰서 read — 에이전트만 값, 휴먼 NULL).
    # S8 composer 가 미지원 런타임 에이전트 pre-send 경고를 그리려면 participant 응답에 runtime_type 필요.
    runtime_type_map: dict[uuid.UUID, str | None] = {}
    if all_member_ids:
        rt_rows = (await db.execute(
            select(TeamMember.id, TeamMember.runtime_type).where(TeamMember.id.in_(all_member_ids))
        )).all()
        runtime_type_map = {r.id: r.runtime_type for r in rt_rows}

    conv_participants: dict[uuid.UUID, list[dict]] = defaultdict(list)
    for r in p_rows:
        resolved = resolved_map.get(r.member_id)
        conv_participants[r.conversation_id].append({
            "member_id": str(r.member_id),
            "name": resolved.name if resolved else str(r.member_id)[:8],
            "avatar_url": getattr(resolved, "avatar_url", None) if resolved else None,
            "type": resolved.type if resolved else "human",
            "runtime_type": runtime_type_map.get(r.member_id),
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
            "muted": caller_muted.get(conv.id, False),  # 270c87e6: FE mute 토글 초기 상태
            "latest_message": {
                "content": latest_msg.content,
                "created_at": latest_msg.created_at.isoformat(),
            } if latest_msg else None,
            "updated_at": conv.updated_at.isoformat(),
        })

    return {"data": result, "total": total, "limit": limit, "offset": offset}


@router.get("/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ConversationResponse:
    """GET /api/v2/conversations/{id} — 단독 메타 조회(project_id 포함).

    03fe1663: 첨부 업로드 라우트가 attachment path의 projectId를 클라이언트 쿠키
    대신 conversation.project_id로 server-side 도출하도록 메타를 제공한다.
    인가(#1262 갱신): admin-bypass=agent-only 대화 한정 — 휴먼 참가 대화(=private)는
    owner/admin도 participant only(사적 DM 프라이버시). 본인 참여 대화는 항상 정상.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=None)
    is_admin = await _effective_org_role(auth, org_id, db, sender) in ("owner", "admin")
    # admin이어도 휴먼 참가(private) 대화면 participant 체크 폴백
    if (not is_admin) or await _conversation_has_human_participant(conversation_id, db):
        sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
        participant = (await db.execute(
            select(ConversationParticipant.id).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.member_id == sender.id,
            )
        )).scalar_one_or_none()
        if participant is None:
            raise HTTPException(status_code=403, detail="Not a participant")

    # 270c87e6: caller의 mute 상태 노출(FE 토글 초기 상태·#1426). 비참여자(admin-bypass agent-only)는 False.
    caller_muted_at = (await db.execute(
        select(ConversationParticipant.muted_at).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    resp = ConversationResponse.model_validate(conv)
    resp.muted = caller_muted_at is not None
    return resp


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

    # #1262: admin-bypass=agent-only 대화 한정 — 휴먼 참가 대화(=private)는 participant only.
    # owner/admin: org-level 조회(project 소속 무관 접근), member: project-level 유지
    sender = await _resolve_member(auth, org_id, db, project_id=None)

    # org-effective role(S-MBR-03·#1223↔SSOT뷰 갭 보정) — project role 낮아도 org owner/admin 상속
    is_admin = await _effective_org_role(auth, org_id, db, sender) in ("owner", "admin")
    # admin이어도 휴먼 참가(private) 대화면 participant 체크 폴백(사적 DM 프라이버시)
    if (not is_admin) or await _conversation_has_human_participant(conversation_id, db):
        # project isolation 보존 — project 소속 member 재확인
        sender = await _resolve_member(auth, org_id, db, project_id=conv_project_id)
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
    member_map = await lookup_members_by_ids(sender_ids, db)

    data = [_msg_payload(m, member_map.get(m.sender_id)) for m in msgs]
    next_cursor = msgs[0].created_at.isoformat() if has_more and msgs else None

    return {"data": data, "meta": {"next_cursor": next_cursor, "has_more": has_more}}


@router.get("/{conversation_id}/working")
async def list_working_members(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """1aeecdde P2: GET /api/v2/conversations/{id}/working — 지금 답장 생성 중인 member 목록.

    presence(online) 와 **별도 축**(working/typing). FE 는 이 결과로 "...is typing"/working dot 을
    online dot 과 분리 표시(AC2). ephemeral·TTL 기반(미reply 시 자동 소멸). participant 만 조회 가능.
    응답: {"data": [{"member_id", "state", "updated_at"}]}.
    """
    conv_project_id = (await db.execute(
        select(Conversation.project_id).where(
            Conversation.id == conversation_id, Conversation.org_id == org_id
        )
    )).scalar_one_or_none()
    if conv_project_id is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv_project_id)
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    # 본인은 제외 — 내가 typing 중인 건 내 UI에 안 띄움(memo presence.py 동형).
    items = [
        e for e in chat_presence.list_working(str(conversation_id))
        if e["member_id"] != str(sender.id)
    ]
    return {"data": items}


@router.patch("/{conversation_id}/mute")
async def set_conversation_mute(
    conversation_id: uuid.UUID,
    body: MuteRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id}/mute — per-대화 알림 mute/unmute (270c87e6).

    caller의 participant 행에 muted_at set(mute)/null(unmute). 참여자 지위·가시성·메시지 수신은
    불변 — 알림 노출만 억제(mute가 발화 carve-out보다 우선). 비참여자는 403.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    sender = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    participant = (await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == sender.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    participant.muted_at = datetime.now(timezone.utc) if body.muted else None
    await db.commit()
    return {"conversation_id": str(conversation_id), "muted": body.muted}


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
    # E-MEMBER-SSOT Phase 0: grant-only 휴먼(org_member)도 참가자로 추가 허용
    target = await resolve_member_identity(body.member_id, org_id, db)
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found")

    # E-MSG-POLICY S1: 참가자 추가도 동일 정책 게이트 (back-door 차단).
    # 기존 참가자 ∪ 신규 대상으로 각 에이전트 정책 재검증 (list 모드 비허용 휴먼 추가 시 403 등).
    _existing_ids = (await db.execute(
        select(ConversationParticipant.member_id)
        .where(ConversationParticipant.conversation_id == conversation_id)
    )).scalars().all()
    await _enforce_agent_creator_policy(sender, list(set(_existing_ids) | {body.member_id}), db)

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
        # 발화 403 해소(270c87e6): 프로젝트 접근권 휴먼이 그룹/스레드 대화에 발화하면 auto-join.
        # _resolve_member가 이미 project 접근을 검증했으므로 접근권은 성립. 단 타인 간 1:1 DM은
        # 예외(비공개 보호·여전히 403)이고, 에이전트 인가(allowlist·creator 동석)는 불변(403 유지).
        if sender.type == "human" and conv.type != "dm":
            db.add(ConversationParticipant(conversation_id=conversation_id, member_id=sender.id))
            await db.flush()
        else:
            raise HTTPException(status_code=403, detail="Not a participant")

    # 1aeecdde P2: sender 가 이 conversation 에 메시지를 보냄 = 답장 생성 종료 → working clear.
    # fork 분기(아래) 전 **원본 conversation_id** 기준 — working 은 그 conversation 에 set 됐다.
    # 휴먼 sender 면 set 된 적 없어 no-op(무해). agent reply 면 즉시 "...typing" 해제.
    chat_presence.clear_working(str(conversation_id), str(sender.id))

    # cross-org 차단: mentioned_ids를 현재 org 소속 member로 일괄 필터링 (QA B1).
    # E-MEMBER-SSOT Phase 0: 저장·DM포크·group 멘션 발송 모든 경로에 org 필터를 한 번 적용.
    #   grant-only 휴먼(org_member) 멘션은 포함하고, cross-org UUID는 저장/발송 전에 제거.
    #   group conversation은 fork 분기가 없어 별도 필터가 누락돼 있던 것을 여기서 함께 막는.
    valid_mentioned_ids: list[uuid.UUID] = []
    if body.mentioned_ids:
        _org_member_ids = await filter_org_member_ids(set(body.mentioned_ids), org_id, db)
        # 원본 순서 보존 + 중복 제거
        _seen: set[uuid.UUID] = set()
        for mid in body.mentioned_ids:
            if mid in _org_member_ids and mid not in _seen:
                _seen.add(mid)
                valid_mentioned_ids.append(mid)

    # CB-S2: DM + 비참여자 멘션 → 자동 그룹 conversation fork (AC1, AC2)
    fork_info: dict | None = None
    if conv.type == "dm" and valid_mentioned_ids:
        valid_member_ids = set(valid_mentioned_ids)

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
        mentioned_ids=valid_mentioned_ids,
        thread_id=body.thread_id,
        # E-FILE S1: 첨부 메타(URL+name+content_type+size)를 0093 attachments JSONB에 저장
        attachments=[a.model_dump() for a in body.attachments],
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

    # E-CHAT-CMD S4: capability gate — 슬래시 커맨드를 미지원 런타임 에이전트에 주입 차단(+audit+hint).
    # 비-command 면 빈 결과 → 무영향. 차단 대상은 dispatch exclude 로 합쳐 주입 0.
    blocked_agent_ids, command_hints = await _command_capability_gate(db, conv, msg, sender, org_id)

    pending_sse_pushes: list[tuple[str, dict]] = []
    try:
        async with db.begin_nested():
            pending_sse_pushes += await _dispatch_conversation_event(db, conv, msg, org_id, sender, exclude_ids=discord_exclude_ids | blocked_agent_ids)
    except Exception as _dispatch_err:
        # dispatch 실패를 삼키지 않고 surface — 게이트웨이 이벤트 미생성 무음 방지
        logger.error("conversation event dispatch failed conversation_id=%s", conversation_id, exc_info=True)
        raise HTTPException(status_code=500, detail="event dispatch failed") from _dispatch_err

    # AC1: 멘션 대상에게 conversation:mention SSE 발송 (participant 여부 무관)
    if msg.mentioned_ids:
        mention_targets = set(msg.mentioned_ids) - {sender.id} - discord_exclude_ids - blocked_agent_ids
        if mention_targets:
            try:
                async with db.begin_nested():
                    pending_sse_pushes += await _dispatch_mention_events(db, conv, msg, org_id, sender, mention_targets)
            except Exception:
                logger.warning("mention event dispatch failed conversation_id=%s", conversation_id, exc_info=True)

    # conversation updated_at 갱신
    conv.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(msg)

    # Phase 6-1: human 발신 메시지 → process_event 훅
    # agent sender는 제외 — agent 응답이 다시 트리거해 무한 루프 생기는 것 방지
    if sender.type != "agent" and conv.project_id:
        try:
            from app.services.workflow_pipeline import process_event
            from app.services.rule_evaluator import EventContext as WorkflowEventContext
            await process_event(db, org_id, conv.project_id, WorkflowEventContext(
                event_type="message.created",
                trigger_type_slug="kickoff",
                actor_id=str(sender.id),
                metadata={
                    "conversation_id": str(conversation_id),
                    "message_id": str(msg.id),
                    "content_preview": (msg.content or "")[:200],
                    "project_id": str(conv.project_id),
                    "org_id": str(org_id),
                    "sender_type": sender.type,
                },
            ))
        except Exception:
            logger.warning("process_event failed for message.created message_id=%s", msg.id, exc_info=True)

    # commit 완료 후 SSE push — Event가 DB에 커밋된 상태에서 push해야 race condition 없음
    for pid_str, sse_payload in pending_sse_pushes:
        _push_to_agent(pid_str, sse_payload)
    # 브라우저 SSE 구독자에게 1회 발행 — pending 유무와 무관하게 commit 후 항상 발행
    publish_event(str(org_id), "conversation.message_created", _msg_payload(msg, sender))  # canonical (S-COMM-12)

    # ws_chat WebSocket 브로드캐스트 — agent 참가자 room에 실시간 전달 (conv.type/title 무관)
    try:
        from app.routers.ws_chat import _broadcast, _rooms

        if _rooms:  # 활성 WS 연결 없으면 쿼리 스킵
            # ConversationParticipant 중 agent type 멤버 수집
            agent_result = await db.execute(
                select(TeamMember.id)
                .join(ConversationParticipant, ConversationParticipant.member_id == TeamMember.id)
                .where(
                    ConversationParticipant.conversation_id == conversation_id,
                    TeamMember.type == "agent",
                )
            )
            agent_ids: set[str] = {str(row[0]) for row in agent_result.all()}

            # ws-chat 전용 conv 호환 — created_by 포함 (participant 테이블에 없는 경우 대비)
            if conv.created_by:
                agent_ids.add(str(conv.created_by))

            if agent_ids:
                ws_payload = json.dumps({
                    "id": str(msg.id),
                    "conversation_id": str(conversation_id),
                    "sender_id": str(sender.id),
                    "sender_name": sender.name,
                    "content": msg.content,
                    "ts": msg.created_at.isoformat(),
                })
                for aid in agent_ids:
                    if aid in _rooms:
                        await _broadcast(aid, ws_payload)
    except Exception:
        logger.warning("ws_chat broadcast failed message_id=%s", msg.id, exc_info=True)

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

    # S-COMM-12 AC1: agent 답신 시 해당 conversation의 최근 gateway_accepted delivery → agent_replied
    if sender.type == "agent":
        from app.services.conversation_webhook import mark_agent_replied
        background_tasks.add_task(mark_agent_replied, conversation_id)

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
    # E-CHAT-CMD S4: 미지원 런타임으로 차단된 커맨드의 hint 를 발신자에게 반환(AC3 hint response).
    if command_hints:
        response["command_gate"] = {"blocked": command_hints}
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


@router.patch("/{conversation_id}", status_code=200)
async def update_conversation(
    conversation_id: uuid.UUID,
    body: UpdateConversationRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PATCH /api/v2/conversations/{id} — 방 title 사용자 편집 (EF-S2 AC3·참여자 권한).

    title 제공 시만 갱신(기본 생성 title 보존). status PATCH 와 동일 참여자 게이트.
    """
    conv = (await db.execute(
        select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    requester = await _resolve_member(auth, org_id, db, project_id=conv.project_id)
    participant = (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.member_id == requester.id,
        )
    )).scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=403, detail="Not a participant")

    if body.title is not None:
        conv.title = body.title
        conv.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(conv)

    return {"id": str(conv.id), "title": conv.title}
