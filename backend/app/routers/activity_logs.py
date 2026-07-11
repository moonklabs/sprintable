"""S-C3: Activity Logs read-only API. CUD 없음. S-C4: EE RBAC 조건부 게이팅."""
import logging
import uuid
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.activity_log import ActivityLog
from app.services.project_auth import has_project_access

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

_ENTITY_TITLE_MODELS: dict[str, type] = {}


def _get_entity_models() -> dict[str, type]:
    if not _ENTITY_TITLE_MODELS:
        from app.models.conversation import Conversation
        from app.models.doc import Doc
        from app.models.pm import Epic, Story, Task
        _ENTITY_TITLE_MODELS.update({
            "story": Story,
            "epic": Epic,
            "task": Task,
            "doc": Doc,
            "conversation": Conversation,
        })
    return _ENTITY_TITLE_MODELS


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
    actor_name: str | None = None
    entity_title: str | None = None

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
    auth: AuthContext = Depends(get_current_user),
) -> ActivityLogListResponse:
    from app.models.team import TeamMember

    # ratchet round7(잔여 HIGH): project_id 필터(지정 시)에 caller 접근권 검증이 없어
    # same-org cross-project 감사 로그(actor/action/entity/context 전문)가 노출됐다 —
    # resource-actual project_id 직접검증. actor_id/entity_id/entity_type 등은 project로
    # 직접 환원되는 FK가 아니라(result-level 노출 축은 별도 스토리 d3e5ca89로 분리 트래킹)
    # 이 라운드 스코프 밖.
    if project_id is not None:
        if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
            raise HTTPException(status_code=404, detail="Project not found")

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
                    TeamMember.id == uuid.UUID(auth.user_id),
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
        # 까심 QA(#2073 REQUEST_CHANGES): 여기서 광범위 Exception을 삼키면 NameError류
        # 코드버그까지 fail-open(무필터 flat log)으로 마스킹된다 — DB/타입 계열의 실제
        # "필터 적용 실패"만 fail-open 허용하고, 나머지 코드 버그(NameError/AttributeError
        # 등)는 그대로 전파해 500으로 가시화한다(조용한 권한 무력화 방지).
        except (LookupError, ValueError, TypeError) as exc:
            logger.warning("activity_logs EE RBAC filter failed — fallback to flat log: %s", exc, exc_info=True)

    total_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = total_result.scalar_one()

    items_result = await db.execute(
        q.order_by(ActivityLog.created_at.desc()).limit(limit).offset(offset)
    )
    items = items_result.scalars().all()

    # batch resolve actor_name. actor_id는 canonical member id로, 0085(member SSOT) 후
    # team_members.id와 다를 수 있다(grant-only/canonical 휴먼). 직접 TeamMember.id 조회는
    # 이들을 놓쳐 actor_name=null → 피드가 '시스템'/'—'으로 표시되던 근본. lookup_members_by_ids
    # 는 anchor/legacy 모두 해소하고 휴먼 이름을 user.email로 정합(member→user/email).
    actor_ids = {item.actor_id for item in items if item.actor_id}
    actor_name_map: dict[uuid.UUID, str] = {}
    if actor_ids:
        from app.services.member_resolver import lookup_members_by_ids
        resolved = await lookup_members_by_ids(actor_ids, db)
        actor_name_map = {mid: rm.name for mid, rm in resolved.items() if rm and rm.name}

    # batch resolve entity_title per entity_type
    entity_ids_by_type: dict[str, set[uuid.UUID]] = defaultdict(set)
    for item in items:
        if item.entity_id and item.entity_type:
            entity_ids_by_type[item.entity_type].add(item.entity_id)

    entity_title_map: dict[tuple[str, uuid.UUID], str | None] = {}
    for etype, eids in entity_ids_by_type.items():
        model = _get_entity_models().get(etype)
        if model:
            rows = (await db.execute(
                select(model.id, model.title).where(model.id.in_(eids))
            )).all()
            for row in rows:
                entity_title_map[(etype, row.id)] = row.title

    def _enrich(log: ActivityLog) -> ActivityLogItem:
        base = ActivityLogItem.model_validate(log)
        return base.model_copy(update={
            "actor_name": actor_name_map.get(log.actor_id) if log.actor_id else None,
            "entity_title": entity_title_map.get((log.entity_type, log.entity_id))
            if log.entity_type and log.entity_id
            else None,
        })

    return ActivityLogListResponse(
        items=[_enrich(item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )
