"""E-EVENTBUS S5: Notifications API — events 테이블 기반 알림 읽음 추적."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.event import Event
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/event-notifications", tags=["event-notifications"])


# ─── Helper ───────────────────────────────────────────────────────────────────

async def _resolve_member_id(
    auth: AuthContext,
    org_id: uuid.UUID,
    db: AsyncSession,
    project_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """JWT auth → team_member_id 반환. project_id 있으면 해당 project member 정확히 지정.

    multi-project 사용자에서 project_id 없으면 임의 member 반환 위험 있음.
    list/unread-count는 project_id query param으로 필터링 권장.
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
    if member_id is None:
        raise HTTPException(status_code=403, detail="Team member not found")
    return member_id


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class NotificationResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
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


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    project_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[NotificationResponse]:
    """GET /api/v2/event-notifications — 현재 사용자의 알림 목록 (최신순).

    project_id 필터: 해당 프로젝트의 member_id로 조회 (multi-project 사용자 대응).
    """
    member_id = await _resolve_member_id(auth, org_id, db, project_id=project_id)
    result = await db.execute(
        select(Event)
        .where(Event.org_id == org_id, Event.recipient_id == member_id)
        .order_by(Event.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    events = result.scalars().all()
    return [NotificationResponse.model_validate(e) for e in events]


@router.get("/unread-count")
async def get_unread_count(
    project_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
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
    # event.project_id로 정확한 member_id resolve → access check
    member_id = await _resolve_member_id(auth, org_id, db, project_id=event.project_id)
    if event.recipient_id != member_id:
        raise HTTPException(status_code=403, detail="Access denied")

    if event.read_at is None:
        event.read_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(event)
    return NotificationResponse.model_validate(event)


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
