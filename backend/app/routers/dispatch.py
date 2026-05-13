"""E-EVENTBUS P3 S12: Dispatch API — entity_type + entity_id → dispatched 이벤트."""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.event import Event, EventType
from app.models.pm import Epic, Story
from app.models.team import TeamMember
from app.routers.events import _event_to_payload, _push_to_agent
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/dispatch", tags=["dispatch"])

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
        return DispatchResponse(dispatched=False)
    # entity의 실제 project_id 사용 (body.project_id 불일치 방지)
    project_id = entity_project_id or body.project_id

    # assignee TeamMember 조회 (type: human/agent)
    member_result = await db.execute(
        select(TeamMember.type).where(TeamMember.id == assignee_id, TeamMember.org_id == org_id)
    )
    member_row = member_result.one_or_none()
    if not member_row:
        return DispatchResponse(dispatched=False, assignee_id=assignee_id)

    member_type = member_row[0]

    # sender_id: 현재 auth user의 TeamMember id
    sender_id: uuid.UUID | None = None
    try:
        uid = uuid.UUID(auth.user_id)
        sender_result = await db.execute(
            select(TeamMember.id).where(
                (TeamMember.user_id == uid) | (TeamMember.id == uid),
                TeamMember.org_id == org_id,
                TeamMember.is_active.is_(True),
            ).limit(1)
        )
        sender_row = sender_result.scalar_one_or_none()
        sender_id = sender_row
    except Exception:
        pass

    payload = {
        "entity_type": body.entity_type,
        "entity_id": str(body.entity_id),
        "title": title,
        "description": (description or "")[:500],
        "message": body.message,
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
    await db.refresh(event)

    if member_type == "agent":
        _push_to_agent(str(assignee_id), _event_to_payload(event))
    else:
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

    await db.commit()
    return DispatchResponse(
        dispatched=True,
        event_id=event.id,
        assignee_id=assignee_id,
        assignee_type=member_type,
    )
