"""E-EVENTBUS P3 S12: Dispatch API — entity_type + entity_id → dispatched 이벤트."""
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.event import Event, EventType
from app.models.pm import Epic, Story
from app.models.team import TeamMember
from app.routers.agent_gateway import wake_agent
from app.routers.events import _event_to_payload, _push_to_agent
from app.services.event_seq import assign_recipient_seq
from app.services.member_resolver import resolve_member_identity
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/dispatch", tags=["dispatch"])

logger = logging.getLogger(__name__)

_ENTITY_TYPES = {"epic", "story", "doc"}


class DispatchRequest(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    project_id: uuid.UUID
    message: str | None = None


class DispatchResponse(BaseModel):
    dispatched: bool
    event_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    assignee_type: str | None = None
    # 7f8066a3: dispatched=False 사유 구분 → FE 가 no_assignee(담당자 미지정·info 안내)와
    # unresolved_assignee(신원 해소 실패·error)를 다르게 표시. additive·null default 하위호환.
    reason: str | None = None


async def _fetch_entity(
    db: AsyncSession,
    entity_type: str,
    entity_id: uuid.UUID,
    org_id: uuid.UUID,
) -> tuple[uuid.UUID | None, str | None, str | None, uuid.UUID | None]:
    """(assignee_id, title, description, project_id) 반환."""
    if entity_type == "epic":
        row = await db.execute(
            select(Epic.assignee_id, Epic.title, Epic.description, Epic.project_id).where(
                Epic.id == entity_id, Epic.org_id == org_id
            )
        )
        r = row.one_or_none()
    elif entity_type == "story":
        row = await db.execute(
            select(Story.assignee_id, Story.title, Story.description, Story.project_id).where(
                Story.id == entity_id, Story.org_id == org_id
            )
        )
        r = row.one_or_none()
    elif entity_type == "doc":
        row = await db.execute(
            select(Doc.assignee_id, Doc.title, Doc.content, Doc.project_id).where(
                Doc.id == entity_id, Doc.org_id == org_id, Doc.deleted_at.is_(None)
            )
        )
        r = row.one_or_none()
    else:
        return None, None, None, None

    if r is None:
        return None, None, None, None
    return r[0], r[1], r[2], r[3]


@router.post("", response_model=DispatchResponse)
async def dispatch_entity(
    body: DispatchRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DispatchResponse:
    """entity의 assignee에게 dispatched 이벤트 생성 + 알림 전달."""
    if body.entity_type not in _ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"entity_type must be one of {_ENTITY_TYPES}")

    assignee_id, title, description, entity_project_id = await _fetch_entity(db, body.entity_type, body.entity_id, org_id)
    if title is None:
        raise HTTPException(status_code=404, detail="Entity not found")
    if not assignee_id:
        # 7f8066a3 (a): 담당자 미지정 — 실패 아님. FE 가 "담당자 지정 필요" 안내(info).
        return DispatchResponse(dispatched=False, reason="no_assignee")
    # entity의 실제 project_id 사용 (body.project_id 불일치 방지)
    project_id = entity_project_id or body.project_id

    # assignee 신원 해소 (type: human/agent)
    # E-MEMBER-SSOT AC2-2: TeamMember-only 검증 → resolve_member_identity (TM∪OM).
    #   grant-only 휴먼/polymorphic assignee도 수용해 dispatched:False 오탐 방지 (7f8066a3).
    assignee_member = await resolve_member_identity(assignee_id, org_id, db)
    if assignee_member is None:
        # 7f8066a3 (a): 담당자 신원 해소 실패(드뭄) — 진짜 오류. FE error 토스트.
        return DispatchResponse(dispatched=False, assignee_id=assignee_id, reason="unresolved_assignee")

    member_type = assignee_member.type

    # sender_id: 현재 auth user의 member id (team_member 우선, grant-only 휴먼은 org_member)
    # B1 교훈 — assignee뿐 아니라 sender 경로도 일관되게 grant-only 수용.
    sender_id: uuid.UUID | None = None
    try:
        uid = uuid.UUID(auth.user_id)
    except (ValueError, TypeError):
        # auth.user_id가 UUID 형식이 아님 (드뭄) — sender 미해소로 진행하되 무음 금지.
        # DB 조회 예외는 아래에서 잡지 않고 전파시켜 silent-swallow를 제거한다.
        logger.warning("dispatch: sender_id 미해소 — auth.user_id가 UUID 아님 user_id=%r", auth.user_id)
    else:
        sender_result = await db.execute(
            select(TeamMember.id).where(
                (TeamMember.user_id == uid) | (TeamMember.id == uid),
                TeamMember.org_id == org_id,
                TeamMember.is_active.is_(True),
            ).limit(1)
        )
        sender_id = sender_result.scalar_one_or_none()
        if sender_id is None:
            # grant-only 휴먼 디스패처 → org_member.id를 sender로 사용
            from app.models.project import OrgMember
            om_result = await db.execute(
                select(OrgMember.id).where(
                    OrgMember.user_id == uid,
                    OrgMember.org_id == org_id,
                    OrgMember.deleted_at.is_(None),
                ).limit(1)
            )
            sender_id = om_result.scalar_one_or_none()

    # E-EVENT-INJECT S1: connector(adapter.py)가 content 없는 이벤트를 드롭(if not content: return)하므로
    # dispatched에 top-level content를 부여 → 에이전트 work-turn으로 실제 주입.
    _detail = (body.message or description or "").strip()
    content = f"[{body.entity_type}] {title}" + (f" — {_detail}" if _detail else "")
    payload = {
        "entity_type": body.entity_type,
        "entity_id": str(body.entity_id),
        "title": title,
        "description": (description or "")[:500],
        "message": body.message,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    event = Event(
        project_id=project_id,
        org_id=org_id,
        event_type=EventType.dispatched.value,
        source_entity_type=body.entity_type,
        source_entity_id=body.entity_id,
        sender_id=sender_id,
        recipient_id=assignee_id,
        recipient_type=member_type,
        payload=payload,
        status="pending",
    )
    db.add(event)
    await db.flush()
    # per-recipient dense seq 발급 (agent recipient만 — commit 순서 직렬화 보장)
    if member_type == "agent":
        await assign_recipient_seq(db, event)

    if member_type != "agent":
        await dispatch_notification(
            db,
            org_id=org_id,
            event_type="dispatched",
            target_member_ids=[assignee_id],
            title=f"[{body.entity_type}] {title}",
            body=body.message or (description or "")[:200] or None,
            reference_type=body.entity_type,
            reference_id=body.entity_id,
        )

    await db.commit()  # commit 후 seq 확정

    # agent: commit 후 wake (gateway_seq 확정 보장, 이중전달 방지)
    if member_type == "agent":
        if event.recipient_seq is not None:
            wake_agent(str(assignee_id), event.recipient_seq)
        else:
            _push_to_agent(str(assignee_id), _event_to_payload(event))

    # 1f01c1ad: wake_agent(SSE)는 CC 세션에 도달하지 않으므로 member webhook(=CC 릴레이 경로)으로도
    # 주입한다. conversation.message_created가 deliver_conversation_message_webhook로 주입되는 것과 동형.
    # webhook 없는 수신자는 no-op. (human도 webhook 보유 시 동일 경로 — 없으면 위 dispatch_notification만)
    from app.services.conversation_webhook import deliver_injected_event_webhook
    background_tasks.add_task(
        deliver_injected_event_webhook,
        org_id=org_id,
        recipient_id=assignee_id,
        content=content,
        event_type="dispatched",
        source_entity_type=body.entity_type,
        source_entity_id=body.entity_id,
    )
    return DispatchResponse(
        dispatched=True,
        event_id=event.id,
        assignee_id=assignee_id,
        assignee_type=member_type,
        reason="ok",
    )
