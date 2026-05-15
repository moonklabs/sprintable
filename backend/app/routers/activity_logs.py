"""S-C3: Activity Logs read-only API. CUD 없음."""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.activity_log import ActivityLog

router = APIRouter(prefix="/api/v2/activity-logs", tags=["activity-logs"])


class ActivityLogItem(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None
    actor_id: uuid.UUID | None
    actor_type: str
    action: str
    entity_type: str | None
    entity_id: uuid.UUID | None
    context: dict
    created_at: datetime

    model_config = {"from_attributes": True}


class ActivityLogListResponse(BaseModel):
    items: list[ActivityLogItem]
    total: int
    limit: int
    offset: int


@router.get("", response_model=ActivityLogListResponse)
async def list_activity_logs(
    project_id: uuid.UUID | None = Query(default=None),
    actor_id: uuid.UUID | None = Query(default=None),
    action: str | None = Query(default=None),
    entity_type: str | None = Query(default=None),
    entity_id: uuid.UUID | None = Query(default=None),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> ActivityLogListResponse:
    # AC5: org scope 필터 (외부 접근 불가 — get_verified_org_id가 403 처리)
    q = select(ActivityLog).where(ActivityLog.org_id == org_id)

    if project_id:
        q = q.where(ActivityLog.project_id == project_id)
    if actor_id:
        q = q.where(ActivityLog.actor_id == actor_id)
    if action:
        q = q.where(ActivityLog.action == action)
    if entity_type:
        q = q.where(ActivityLog.entity_type == entity_type)
    if entity_id:
        q = q.where(ActivityLog.entity_id == entity_id)
    if from_:
        q = q.where(ActivityLog.created_at >= from_)
    if to:
        q = q.where(ActivityLog.created_at <= to)

    total_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = total_result.scalar_one()

    items_result = await db.execute(
        q.order_by(ActivityLog.created_at.desc()).limit(limit).offset(offset)
    )
    items = items_result.scalars().all()

    return ActivityLogListResponse(
        items=[ActivityLogItem.model_validate(item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )
