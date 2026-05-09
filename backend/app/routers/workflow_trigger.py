import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.workflow_execution_log import WorkflowExecutionLog
from app.services.rule_evaluator import EventContext
from app.services.workflow_pipeline import process_event

router = APIRouter(prefix="/api/v2/workflow", tags=["workflow"])

_DEDUP_SECONDS = 30


def _get_org_id(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> uuid.UUID:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=400, detail="org_id required")
    return uuid.UUID(str(org_id_str))


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
    org_id: uuid.UUID = Depends(_get_org_id),
) -> TriggerResponse:
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
