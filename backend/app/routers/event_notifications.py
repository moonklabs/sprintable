"""E-EVENTBUS S5: Notifications API — events 테이블 기반 알림 읽음 추적."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
from app.models.event import Event
from app.services.event_room_gate import stored_event, withheld_payloads
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/event-notifications", tags=["event-notifications", "Organization"])

# 대화 이벤트 종류(휴먼 알림 정책 분기 대상). 비-대화 이벤트(dispatched 등)는 노출(단 채팅 새 메시지의 dispatched 사본은 아래 4890 — 같은 글의 message_created 줄과 겹쳐 뺀다).
_CONVERSATION_EVENT_TYPES = ("conversation.message_created", "conversation:mention")
# story #4520 (Yuna 03:57Z · PO) — the approvals inbox's own signals (approval_delivery: a new gate · decided · delegated · tossed).
# «No new message, a pure SSE signal» there: they redraw an open approvals inbox, and the reconnect backfill rebuilds them from
# these rows (4505), so the rows stay — but they were never a person's alert line. On the bell they showed as one more line and +1
# unread with no label (a decision request read twice next to its `gate.pending_approval`). Who must know learns it elsewhere:
# the approver from that alert and the chat card, the requester from the result reply.
_APPROVALS_INBOX_SIGNAL_TYPES = (
    "conversation.gate_created", "conversation.gate_resolved", "conversation.gate_delegated", "conversation.gate_tossed",
)
# story 4890 (UI-7 · PO 11-10) — one chat message made TWO bell rows for a person who is in the room: the `conversation.message_created` Event (summary «보낸 이: 미리보기» · sender · room id — the row the
# bell links to the room from) and the `dispatched` Event that `dispatch_notification` writes for story 1934 («every human in the thread gets an in-app notification + Expo push for a new message»),
# whose payload.event_type is `conversation.message`. Measured on dev: 2 messages → 4 lines and a badge of 4. The `dispatched` row also carries the push / personal-webhook delivery (outbox) — that
# stays; only the BELL READ leaves the row out, and the hiding rules below (mute · spectator) decide on the message_created row alone — so for every account «lines = messages, unread = messages».
_CHAT_MESSAGE_DISPATCHED = "conversation.message"


def _is_hidden_notification(member_id: uuid.UUID):
    """휴먼 알림에서 숨길 대화 이벤트 판별 (48dbada0 + 270c87e6 · 선생님 정책).

    숨김(둘 중 하나):
    1. **mute**(270c87e6 ③): member가 그 대화를 mute → 그 대화의 모든 conversation 이벤트
       (message_created·mention) 숨김. carve-out·DM보다 우선. 참여/가시성/수신은 불변(알림만).
    2. **spectator**(48dbada0): 그룹 대화의 message_created인데 member가 그 대화에서 **발화한 적
       없음** → 관전 동석 알림이라 숨김. ⇄ **carve-out**(270c87e6 ②): 발화한 적 있으면 노출.

    3. **결재함 신호**(story #4520): `_APPROVALS_INBOX_SIGNAL_TYPES` — 결재함을 새로 그리는 SSE 신호라 사람 알림 줄이 아님.
    4. **채팅 새 메시지의 dispatched 사본**(story 4890): 같은 글의 message_created 줄이 이미 벨 줄이다 — 이 사본은 벨 목록 · 읽지 않음 수에서 뺀다(행은 그대로 · 푸시/웹훅 배달은 이 행을 만든 같은
       호출이 outbox로 하므로 무관). mute · 관전 가림은 message_created에만 걸리므로 «가릴 건 같이 가려지고 보일 건 한 줄만»이 된다. 사람 수신자만(에이전트는 그 사본이 유일한 알림일 수 있다).
       ⚠️ 의도된 결과 하나: 채널 라우터(`route_message`)가 음소거 · «멘션만» 수신자를 결정에서 빼 message_created를 안 만든 참여자(`conversation.py`의 `preference_excluded_ids`)는 사본 쪽에만
       줄이 있었다 — 그 사람들은 «멘션 아닌 글은 알리지 말라»고 한 사람이라 이 사본이 그 설정을 무시한 것이었다(벨에 «새 메시지»가 매 글마다). 이제 그 줄도 사라진다 = 설정대로. (푸시 쪽은 이 PR 밖.)

    노출(직접 필요): DM 메시지·@mention(별도 type)·발화한 그룹 대화·dispatched 등 비-대화 이벤트.
    ⚠️ Event/SSE/에이전트 주입 경로 불변 — 휴먼 알림 읽기 단에만 적용.
    """
    # 이 Event의 소스 메시지(EvtMsg). EXISTS가 EvtMsg.id == Event.source_entity_id로 outer Event에
    # correlate된다(scalar 서브쿼리 오-correlate 회피). 비-대화 이벤트면 EvtMsg 매칭 0 → 전부 false.
    evt_msg = aliased(ConversationMessage)
    my_msg = aliased(ConversationMessage)
    muted = exists(
        select(1)
        .select_from(evt_msg)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == evt_msg.conversation_id)
        .where(
            evt_msg.id == Event.source_entity_id,
            ConversationParticipant.member_id == member_id,
            ConversationParticipant.muted_at.isnot(None),
        )
    )
    is_group = exists(
        select(1)
        .select_from(evt_msg)
        .join(Conversation, Conversation.id == evt_msg.conversation_id)
        .where(evt_msg.id == Event.source_entity_id, Conversation.type != "dm")
    )
    spoke = exists(
        select(1)
        .select_from(evt_msg)
        .join(my_msg, my_msg.conversation_id == evt_msg.conversation_id)
        .where(evt_msg.id == Event.source_entity_id, my_msg.sender_id == member_id)
    )
    return or_(
        and_(Event.event_type.in_(_CONVERSATION_EVENT_TYPES), muted),         # mute: 대화 전체 무음
        and_(Event.event_type == "conversation.message_created", is_group, ~spoke),  # 미발화 그룹 관전
        Event.event_type.in_(_APPROVALS_INBOX_SIGNAL_TYPES),                        # story #4520 — 결재함 신호
        # coalesce: a dispatched row whose payload has no `event_type` key (or no recipient_type) would make this term NULL, and `NOT (… OR NULL)` is NULL — the row would drop out of the bell (SQL three-valued logic)
        and_(Event.event_type == "dispatched", func.coalesce(Event.recipient_type, "") == "human",
             func.coalesce(Event.payload["event_type"].astext, "") == _CHAT_MESSAGE_DISPATCHED),  # story 4890 — 같은 글의 두 번째 줄(사람 몫만 — 에이전트가 받은 dispatched는 그 에이전트의 유일한 알림일 수 있다)
    )


async def sync_notification_read_on_chat_read(
    db: AsyncSession,
    org_id: uuid.UUID,
    conversation_id: uuid.UUID,
    member_id: uuid.UUID,
    up_to: datetime,
) -> int:
    """story #2686(축D): 채팅 read → 그 대화 소속 event-notification(벨/인박스) read_at 동기.

    «노티 받고 들어왔는데 잔상» 근본수정 — 채팅 read는 원래 ConversationParticipant.
    last_read_at만 갱신하고 Event.read_at은 안 건드려 벨/인박스에 그대로 남아있었다.

    매칭 축: recipient_id(내 알림만) + event_type(대화 이벤트만, _is_hidden_notification과
    동일 상수) + source_entity_id가 «이 대화 소속이면서 up_to 이전에 생성된» 메시지. 다른
    대화·비채팅 알림은 이 WHERE에 안 걸려 불변(AC2 음성대조).

    up_to는 호출부가 GREATEST 래칫(_mark_read_update_stmt) 통과 후 받은 값을 넘겨야 한다
    (미르코 보강) — 「일부만 읽음」 호출이 up_to보다 미래에 온 메시지의 알림까지 앞당겨
    읽음 처리하는 과잉살상을 막는다. read_at IS NULL 필터로 멱등(AC3 — 이미 읽은 알림 재갱신 0).
    """
    evt_msg = aliased(ConversationMessage)
    stmt = (
        update(Event)
        .where(
            Event.org_id == org_id,
            Event.recipient_id == member_id,
            Event.event_type.in_(_CONVERSATION_EVENT_TYPES),
            Event.read_at.is_(None),
            Event.source_entity_id.in_(
                select(evt_msg.id).where(
                    evt_msg.conversation_id == conversation_id,
                    evt_msg.created_at <= up_to,
                )
            ),
        )
        .values(read_at=datetime.now(timezone.utc))
    )
    result = await db.execute(stmt)
    cleared = result.rowcount
    # story 4890 — the `dispatched` copy of a chat message (hidden from the bell read above) names the ROOM (source_entity_id = the conversation), not a message; reading the room clears the copies that came
    # up to `up_to` as well, so they never wait as «unread» rows that a later change of the bell rule could bring back
    copies = await db.execute(
        update(Event)
        .where(
            Event.org_id == org_id,
            Event.recipient_id == member_id,
            Event.event_type == "dispatched",
            Event.payload["event_type"].astext == _CHAT_MESSAGE_DISPATCHED,
            Event.source_entity_type == "conversation",
            Event.source_entity_id == conversation_id,
            Event.read_at.is_(None),
            Event.created_at <= up_to,
        )
        .values(read_at=datetime.now(timezone.utc))
    )
    return cleared + copies.rowcount


# ─── Helper ───────────────────────────────────────────────────────────────────

async def _resolve_member_id(
    auth: AuthContext,
    org_id: uuid.UUID,
    db: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """JWT auth → canonical member_id 반환. project_id 있으면 해당 project member 정확히 지정.

    0d68ad20: team_member 행만 요구하면 grant-only/admin 휴먼(team_member 없음)이 `/api/projects`엔
    보이는 프로젝트에서 403 — has_project_access SSOT와 인가 불일치. team_member 곱연산 의존을 버리고
    SSOT 리졸버(resolve_member)로 canonical id 해소. 미인가는 resolve_member가 403/400.
    """
    user_id = uuid.UUID(str(auth.user_id))
    filters = [
        or_(TeamMember.user_id == user_id, TeamMember.id == user_id),
        TeamMember.org_id == org_id,
    ]
    if project_id:
        filters.append(TeamMember.project_id == project_id)
    result = await db.execute(
        select(TeamMember.id).where(*filters).limit(1)
    )
    member_id = result.scalar_one_or_none()
    if member_id is not None:
        return member_id
    # team_member 행 없음 — SSOT 리졸버로 해소(team_member 곱연산 의존 제거). 휴먼=has_project_access
    # 후 canonical org_member.id, 에이전트=team_member.id. 미인가면 resolve_member가 403/400.
    # events는 recipient(canonical id)-addressed라 grant-only 휴먼은 자연히 0건(빈 결과).
    from app.services.member_resolver import resolve_member
    return (await resolve_member(auth, org_id, db, project_id=project_id)).id


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class NotificationResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None = None  # story #4846: a room without a project has none
    event_type: str
    source_entity_type: str | None
    source_entity_id: uuid.UUID | None
    sender_id: uuid.UUID | None
    recipient_id: uuid.UUID
    recipient_type: str
    payload: dict
    status: str
    created_at: datetime
    delivered_at: datetime | None
    read_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class NotificationListItem(NotificationResponse):
    """story #4244 — 종 알림 목록 항목: 대상(source_entity)의 프로젝트와 문서 slug(목록 조회 때 배치 해소). events.project_id는 대상의
    프로젝트가 아니다(사람 수신자 dispatched 이벤트는 수신자 멤버 행의 project_id — notification_dispatch.py). 표시·링크 전용."""

    target_project_id: uuid.UUID | None = None
    target_doc_slug: str | None = None


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[NotificationListItem])
async def list_notifications(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    project_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[NotificationListItem]:
    """GET /api/v2/event-notifications — 현재 사용자의 알림 목록 (최신순).

    project_id 필터: 해당 프로젝트의 member_id로 조회 (multi-project 사용자 대응).
    """
    member_id = await _resolve_member_id(auth, org_id, db, project_id=project_id)
    result = await db.execute(
        select(Event)
        .where(
            Event.org_id == org_id,
            Event.recipient_id == member_id,
            ~_is_hidden_notification(member_id),  # 48dbada0+270c87e6: mute·미발화 그룹 관전 제외
        )
        .order_by(Event.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    events = result.scalars().all()
    # story #4870: a stored copy of a room's words is read back only by who may read the room NOW (the words are taken out of the copy handed back otherwise; the row stays)
    withheld = await withheld_payloads(db, org_id, auth, [stored_event(e) for e in events])
    items = [NotificationListItem(**{**NotificationResponse.model_validate(e).model_dump(), **({"payload": withheld[str(e.id)]} if str(e.id) in withheld else {})}) for e in events]
    from app.services.notification_targets import resolve_reference_targets
    targets = await resolve_reference_targets(db, org_id, ((i.source_entity_type, i.source_entity_id) for i in items))
    for i in items:
        tgt = targets.get((i.source_entity_type, i.source_entity_id)) if i.source_entity_type and i.source_entity_id else None
        if tgt is not None:
            i.target_project_id = tgt.project_id
            i.target_doc_slug = tgt.doc_slug
    return items


@router.get("/unread-count")
async def get_unread_count(
    project_id: uuid.UUID | None = Query(default=None),
    # story #2451(§6 Phase3 A1): 고빈도 카운터·create→self-read 흐름 없음 → read replica.
    db: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """GET /api/v2/event-notifications/unread-count — 읽지 않은 알림 수.

    project_id 필터: 해당 프로젝트 알림만 집계.
    """
    member_id = await _resolve_member_id(auth, org_id, db, project_id=project_id)
    result = await db.execute(
        select(func.count()).where(
            Event.org_id == org_id,
            Event.recipient_id == member_id,
            Event.read_at.is_(None),
            ~_is_hidden_notification(member_id),  # 48dbada0+270c87e6: mute·미발화 그룹 관전 제외
        )
    )
    count = result.scalar_one()
    return {"count": count}


@router.patch("/{event_id}/read", response_model=NotificationResponse)
async def mark_read(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> NotificationResponse:
    """PATCH /api/v2/event-notifications/{id}/read — 단일 알림 읽음 처리."""
    result = await db.execute(
        select(Event).where(
            Event.id == event_id,
            Event.org_id == org_id,
        )
    )
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    # story #4846: the recipient is the caller, whatever happened to their access to the event's project (a participant who lost it still marks their own
    # line read; the event may carry no project at all) — so the member is resolved for the organization; `recipient_id != member_id` below is the gate.
    member_id = await _resolve_member_id(auth, org_id, db, project_id=None)
    if event.recipient_id != member_id:
        raise HTTPException(status_code=403, detail="Access denied")

    if event.read_at is None:
        event.read_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(event)
    response = NotificationResponse.model_validate(event)
    # story #4870: the same gate as the list (the stored row is not touched; only the copy handed back loses the words)
    withheld = await withheld_payloads(db, org_id, auth, [stored_event(event)])
    if str(event.id) in withheld:
        response.payload = withheld[str(event.id)]
    return response


@router.patch("/read-all")
async def mark_all_read(
    project_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """PATCH /api/v2/event-notifications/read-all — 전체 읽음 처리."""
    member_id = await _resolve_member_id(auth, org_id, db, project_id=project_id)
    now = datetime.now(timezone.utc)
    result = await db.execute(
        update(Event)
        .where(
            Event.org_id == org_id,
            Event.recipient_id == member_id,
            Event.read_at.is_(None),
        )
        .values(read_at=now)
    )
    await db.commit()
    return {"updated": result.rowcount}
