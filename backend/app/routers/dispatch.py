
import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.services.agent_dispatch import DispatchResponse, dispatch_entity_to_assignee

router = APIRouter(prefix="/api/v2/dispatch", tags=["dispatch"])

logger = logging.getLogger(__name__)


class DispatchRequest(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    project_id: uuid.UUID
    message: str | None = None


async def _resolve_sender_id(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID) -> uuid.UUID | None:
    """현재 auth user의 member id 해소 (team_member 우선, grant-only 휴먼은 org_member).

    B1 교훈 — assignee뿐 아니라 sender 경로도 일관되게 grant-only 수용. auth 의존이라 라우터에
    남기고, 서비스에는 해소된 sender_id를 넘긴다.
    """
    try:
        uid = uuid.UUID(auth.user_id)
    except (ValueError, TypeError):
        # auth.user_id가 UUID 형식이 아님(드뭄) — sender 미해소로 진행하되 무음 금지.
        logger.warning("dispatch: sender_id 미해소 — auth.user_id가 UUID 아님 user_id=%r", auth.user_id)
        return None

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
    return sender_id


@router.post("", response_model=DispatchResponse)
async def dispatch_entity(
    body: DispatchRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DispatchResponse:
    """entity의 assignee에게 dispatched 이벤트 생성 + 알림 전달.

    핵심 로직은 `app/services/agent_dispatch.py::dispatch_entity_to_assignee`로 추출됐고(L2-S1),
    라우터는 auth 기반 sender 해소 + CC 릴레이 webhook의 background 스케줄만 담당하는 얇은 wrapper다.
    """
    sender_id = await _resolve_sender_id(db, auth, org_id)
    response, delivery = await dispatch_entity_to_assignee(
        db,
        org_id,
        body.entity_type,
        body.entity_id,
        body.message,
        sender_id=sender_id,
    )
    # 1f01c1ad: wake_agent(SSE)는 CC 세션에 도달하지 않으므로 member webhook(=CC 릴레이)으로도 주입.
    # HTTP 경로는 응답을 막지 않도록 background로 스케줄(서비스는 delivery 파라미터만 반환).
    if delivery is not None:
        from app.services.conversation_webhook import deliver_injected_event_webhook
        background_tasks.add_task(deliver_injected_event_webhook, **delivery)
    return response
