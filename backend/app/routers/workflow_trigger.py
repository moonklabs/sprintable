import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.workflow_execution_log import WorkflowExecutionLog
from app.services.rule_evaluator import EventContext
from app.services.workflow_pipeline import process_event

router = APIRouter(prefix="/api/v2/workflow", tags=["workflow"])

_DEDUP_SECONDS = 30


class TriggerRequest(BaseModel):
    project_id: uuid.UUID
    story_id: str
    trigger_type_slug: str = "kickoff"


class TriggerResponse(BaseModel):
    status: str
    execution_id: str | None = None
    message: str | None = None


@router.post("/trigger", response_model=TriggerResponse)
async def trigger_workflow(
    body: TriggerRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TriggerResponse:
    # E-SECURITY SEC-S8(story 83ea3d6a) Z2(까심 전수스윕, 실HTTP 확定): body.project_id에
    # has_project_access 검증 자체가 없어, project_a만 grant된 caller가 body.project_id=project_b로
    # 요청하면 project_b 전용 enabled rule이 실제로 매치되고 WorkflowExecutionLog가 생성됐다
    # (남의 project 워크플로 실행 트리거). has_project_access(org_id 지정)가 "project가 caller
    # org 소속"과 "caller 접근권" 둘 다 커버.
    from app.services.project_auth import has_project_access
    if not await has_project_access(db, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_DEDUP_SECONDS)
    recent = await db.execute(
        select(WorkflowExecutionLog.id)
        .where(
            WorkflowExecutionLog.org_id == org_id,
            WorkflowExecutionLog.project_id == body.project_id,
            WorkflowExecutionLog.trigger_type_slug == body.trigger_type_slug,
            WorkflowExecutionLog.event_context["metadata"]["story_id"].astext == body.story_id,
            WorkflowExecutionLog.created_at >= cutoff,
        )
        .limit(1)
    )
    if recent.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="Workflow already triggered recently for this story",
        )

    ctx = EventContext(
        event_type="manual_trigger",
        trigger_type_slug=body.trigger_type_slug,
        actor_id=str(auth.user_id),
        metadata={"story_id": body.story_id},
    )

    await process_event(db, org_id, body.project_id, ctx)
    await db.commit()

    last_log = await db.execute(
        select(WorkflowExecutionLog)
        .where(
            WorkflowExecutionLog.org_id == org_id,
            WorkflowExecutionLog.project_id == body.project_id,
            WorkflowExecutionLog.trigger_type_slug == body.trigger_type_slug,
        )
        .order_by(WorkflowExecutionLog.created_at.desc())
        .limit(1)
    )
    log = last_log.scalar_one_or_none()

    if log and log.status in ("matched", "running", "completed"):
        return TriggerResponse(
            status="triggered",
            execution_id=str(log.id),
        )
    return TriggerResponse(status="no_match", message="No matching rule found")
