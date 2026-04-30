import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.repositories.agent_run import AgentRunRepository
from app.schemas.agent_run import AgentRunResponse, CreateAgentRun, UpdateAgentRun

router = APIRouter(prefix="/api/v2/agent-runs", tags=["agent-runs"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> AgentRunRepository:
    return AgentRunRepository(session)


@router.get("", response_model=list[AgentRunResponse])
async def list_agent_runs(
    project_id: uuid.UUID = Query(...),
    agent_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> list[AgentRunResponse]:
    runs = await repo.list(project_id=project_id, agent_id=agent_id, limit=limit, cursor=cursor)
    return [AgentRunResponse.model_validate(r) for r in runs]


@router.post("", response_model=AgentRunResponse, status_code=201)
async def create_agent_run(
    body: CreateAgentRun,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    member_r = await session.execute(
        select(TeamMember.org_id).where(
            TeamMember.id == body.agent_id, TeamMember.type == "agent"
        )
    )
    org_id = member_r.scalar_one_or_none()
    if org_id is None:
        raise HTTPException(status_code=400, detail="agent_id not found or not an agent")

    run = await repo.create(
        org_id=org_id,
        agent_id=body.agent_id,
        trigger=body.trigger,
        model=body.model,
        story_id=body.story_id,
        memo_id=body.memo_id,
        status=body.status,
        result_summary=body.result_summary,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        cost_usd=body.cost_usd,
        duration_ms=body.duration_ms,
    )
    return AgentRunResponse.model_validate(run)


@router.patch("/{id}", response_model=AgentRunResponse)
async def update_agent_run(
    id: uuid.UUID,
    body: UpdateAgentRun,
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    run = await repo.update(
        id,
        status=body.status,
        result_summary=body.result_summary,
        input_tokens=body.input_tokens,
        output_tokens=body.output_tokens,
        cost_usd=body.cost_usd,
        duration_ms=body.duration_ms,
        last_error_code=body.last_error_code,
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return AgentRunResponse.model_validate(run)
