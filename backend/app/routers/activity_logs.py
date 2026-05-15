"""S-C3: Activity Logs read-only API. CUD 없음. S-C4: EE RBAC 조건부 게이팅."""
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.activity_log import ActivityLog

logger = logging.getLogger(__name__)

# S-C4: EE RBAC — CE 코드에 top-level import ee 금지. 조건부 로드.
_ee_rbac_filter = None
try:
    from app.core.config import settings as _settings
    if _settings.is_ee_enabled:
        from ee.services.audit_rbac import filter_activity_by_role as _ee_rbac_filter  # type: ignore[assignment]
        logger.info("activity_logs: EE RBAC filter loaded")
except Exception:
    pass

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
    from app.models.team import TeamMember

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

    # S-C4: EE RBAC — is_ee_enabled 시 role별 가시성 필터 적용
    ee_applied = False
    if _ee_rbac_filter is not None:
        try:
            caller_tm = (await db.execute(
                select(TeamMember).where(
                    TeamMember.id == uuid.UUID(_auth.user_id),
                    TeamMember.org_id == org_id,
                ).limit(1)
            )).scalar_one_or_none()
            if caller_tm:
                q = _ee_rbac_filter(q, caller_tm.role, caller_tm.id)
                ee_applied = True
                logger.info(
                    "activity_logs EE RBAC applied role=%s member_id=%s",
                    caller_tm.role, caller_tm.id,
                )
        except Exception:
            logger.warning("activity_logs EE RBAC filter failed — fallback to flat log", exc_info=True)

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
