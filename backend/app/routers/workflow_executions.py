import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, require_admin
from app.dependencies.database import get_db
from app.models.agent_routing_rule import AgentRoutingRule
from app.models.team import TeamMember
from app.models.workflow_execution_log import WorkflowExecutionLog

router = APIRouter(prefix="/api/v2/workflow-executions", tags=["workflow-executions"])


def _get_org_id(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> uuid.UUID:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=400, detail="org_id required")
    return uuid.UUID(str(org_id_str))


class ExecutionLogItem(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    rule_id: uuid.UUID | None
    rule_name: str | None
    event_type: str
    trigger_type_slug: str | None
    target_agent_id: uuid.UUID | None
    agent_name: str | None
    status: str
    error_message: str | None
    duration_ms: int | None
    created_at: datetime
    completed_at: datetime | None

    model_config = {"from_attributes": True}


class ExecutionLogDetail(ExecutionLogItem):
    event_context: dict
    action: dict | None


class ExecutionLogListResponse(BaseModel):
    items: list[ExecutionLogItem]
    total: int
    offset: int
    limit: int


@router.get("", response_model=ExecutionLogListResponse)
async def list_executions(
    project_id: uuid.UUID = Query(...),
    event_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(_get_org_id),
    _: AuthContext = Depends(require_admin),
) -> ExecutionLogListResponse:
    base = (
        select(WorkflowExecutionLog)
        .where(
            WorkflowExecutionLog.org_id == org_id,
            WorkflowExecutionLog.project_id == project_id,
        )
    )
    if event_type:
        base = base.where(WorkflowExecutionLog.event_type == event_type)
    if status:
        base = base.where(WorkflowExecutionLog.status == status)

    total_result = await db.execute(select(func.count()).select_from(base.subquery()))
    total: int = total_result.scalar_one() or 0

    rows_result = await db.execute(
        base.order_by(WorkflowExecutionLog.created_at.desc()).offset(offset).limit(limit)
    )
    logs = list(rows_result.scalars().all())

    if not logs:
        return ExecutionLogListResponse(items=[], total=total, offset=offset, limit=limit)

    rule_ids = {log.rule_id for log in logs if log.rule_id}
    agent_ids = {log.target_agent_id for log in logs if log.target_agent_id}

    rule_name_map: dict[uuid.UUID, str] = {}
    if rule_ids:
        rr = await db.execute(
            select(AgentRoutingRule.id, AgentRoutingRule.name).where(AgentRoutingRule.id.in_(rule_ids))
        )
        rule_name_map = {row.id: row.name for row in rr.all()}

    agent_name_map: dict[uuid.UUID, str] = {}
    if agent_ids:
        ar = await db.execute(
            select(TeamMember.id, TeamMember.name).where(TeamMember.id.in_(agent_ids))
        )
        agent_name_map = {row.id: row.name for row in ar.all()}

    items = [
        ExecutionLogItem(
            id=log.id,
            org_id=log.org_id,
            project_id=log.project_id,
            rule_id=log.rule_id,
            rule_name=rule_name_map.get(log.rule_id) if log.rule_id else None,
            event_type=log.event_type,
            trigger_type_slug=log.trigger_type_slug,
            target_agent_id=log.target_agent_id,
            agent_name=agent_name_map.get(log.target_agent_id) if log.target_agent_id else None,
            status=log.status,
            error_message=log.error_message,
            duration_ms=log.duration_ms,
            created_at=log.created_at,
            completed_at=log.completed_at,
        )
        for log in logs
    ]
    return ExecutionLogListResponse(items=items, total=total, offset=offset, limit=limit)


@router.get("/{id}", response_model=ExecutionLogDetail)
async def get_execution(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(_get_org_id),
    _: AuthContext = Depends(require_admin),
) -> ExecutionLogDetail:
    result = await db.execute(
        select(WorkflowExecutionLog).where(
            WorkflowExecutionLog.id == id,
            WorkflowExecutionLog.org_id == org_id,
        )
    )
    log = result.scalar_one_or_none()
    if log is None:
        raise HTTPException(status_code=404, detail="Execution log not found")

    rule_name: str | None = None
    if log.rule_id:
        rr = await db.execute(
            select(AgentRoutingRule.name).where(AgentRoutingRule.id == log.rule_id)
        )
        rule_name = rr.scalar_one_or_none()

    agent_name: str | None = None
    if log.target_agent_id:
        ar = await db.execute(
            select(TeamMember.name).where(TeamMember.id == log.target_agent_id)
        )
        agent_name = ar.scalar_one_or_none()

    return ExecutionLogDetail(
        id=log.id,
        org_id=log.org_id,
        project_id=log.project_id,
        rule_id=log.rule_id,
        rule_name=rule_name,
        event_type=log.event_type,
        trigger_type_slug=log.trigger_type_slug,
        target_agent_id=log.target_agent_id,
        agent_name=agent_name,
        status=log.status,
        error_message=log.error_message,
        duration_ms=log.duration_ms,
        created_at=log.created_at,
        completed_at=log.completed_at,
        event_context=log.event_context or {},
        action=log.action,
    )
