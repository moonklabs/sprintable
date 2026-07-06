import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
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
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> list[AgentRunResponse]:
    """prod 핫픽스(S20 전수스캔 — create_agent_run과 동일 클래스): project_id가 caller org
    소속인지 검증 없이 임의 project의 agent run 목록을 열람할 수 있었다(cross-org)."""
    proj_r = await session.execute(select(Project.id).where(Project.id == project_id, Project.org_id == org_id))
    if proj_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Project not found")
    runs = await repo.list(project_id=project_id, agent_id=agent_id, limit=limit, cursor=cursor)
    return [AgentRunResponse.model_validate(r) for r in runs]


@router.post("", response_model=AgentRunResponse, status_code=201)
async def create_agent_run(
    body: CreateAgentRun,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """prod 핫픽스(S20 전수스캔 MUST): cross-org IDOR — org_id를 body.agent_id가 속한 org에서
    그대로 파생해(caller org 검증 없이) 타 org agent 명의로 run을 생성할 수 있었다. caller의
    get_verified_org_id로 파생하고 agent_id가 그 org 소속인지 검증한다.
    """
    # team_members 는 projection VIEW — 멀티프로젝트 grant 면 같은 agent_id 가 N 행. org_id 필터로
    # caller org 소속만 통과(cross-org 차단) — .limit(1) 로 MultipleResultsFound 회피.
    member_r = await session.execute(
        select(TeamMember.id).where(
            TeamMember.id == body.agent_id, TeamMember.type == "agent", TeamMember.org_id == org_id,
            TeamMember.is_active.is_(True),  # deactivated agent 는 run 생성 비도달(정합)
        ).limit(1)
    )
    if member_r.scalar_one_or_none() is None:
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
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    repo: AgentRunRepository = Depends(_get_repo),
) -> AgentRunResponse:
    """prod 핫픽스(S20 전수스캔 — create_agent_run과 동일 클래스): run id만으로 org 검증 없이
    임의 org의 agent run을 수정할 수 있었다."""
    existing = await repo.get(id)
    if existing is None or existing.org_id != org_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
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
