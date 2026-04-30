import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.analytics import AnalyticsRepository
from app.schemas.analytics import (
    AgentStatsResponse,
    BurndownResponse,
    EpicProgressResponse,
    MemberWorkloadResponse,
    ProjectHealthResponse,
    ProjectOverviewResponse,
    RecentActivityResponse,
    SprintVelocityItem,
    SprintVelocityResponse,
)

router = APIRouter(prefix="/api/v2", tags=["analytics"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> AnalyticsRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return AnalyticsRepository(session, uuid.UUID(str(org_id_str)))


@router.get("/analytics/overview", response_model=ProjectOverviewResponse)
async def get_overview(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> ProjectOverviewResponse:
    data = await repo.get_overview(project_id)
    return ProjectOverviewResponse.model_validate(data)


@router.get("/analytics/workload", response_model=MemberWorkloadResponse)
async def get_member_workload(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> MemberWorkloadResponse:
    data = await repo.get_member_workload(project_id, member_id)
    return MemberWorkloadResponse.model_validate(data)


@router.get("/analytics/velocity-history", response_model=list[SprintVelocityItem])
async def get_velocity_history(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> list[SprintVelocityItem]:
    items = await repo.get_velocity_history(project_id)
    return [SprintVelocityItem.model_validate(i) for i in items]


@router.get("/analytics/activity", response_model=RecentActivityResponse)
async def get_recent_activity(
    project_id: uuid.UUID = Query(...),
    limit: int = Query(default=10, ge=1, le=100),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> RecentActivityResponse:
    data = await repo.get_recent_activity(project_id, limit)
    return RecentActivityResponse.model_validate(data)


@router.get("/analytics/epic-progress", response_model=EpicProgressResponse)
async def get_epic_progress(
    project_id: uuid.UUID = Query(...),
    epic_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> EpicProgressResponse:
    data = await repo.get_epic_progress(project_id, epic_id)
    return EpicProgressResponse.model_validate(data)


@router.get("/analytics/agent-stats", response_model=AgentStatsResponse)
async def get_agent_stats(
    project_id: uuid.UUID = Query(...),
    agent_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> AgentStatsResponse:
    data = await repo.get_agent_stats(project_id, agent_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Agent not found in project")
    return AgentStatsResponse.model_validate(data)


@router.get("/analytics/health", response_model=ProjectHealthResponse)
async def get_project_health(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
) -> ProjectHealthResponse:
    data = await repo.get_project_health(project_id)
    return ProjectHealthResponse.model_validate(data)


@router.get("/sprints/{sprint_id}/burndown", response_model=BurndownResponse)
async def get_burndown(
    sprint_id: uuid.UUID,
    repo: AnalyticsRepository = Depends(_get_repo),
) -> BurndownResponse:
    data = await repo.get_burndown(sprint_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return BurndownResponse.model_validate(data)


@router.get("/sprints/{sprint_id}/velocity", response_model=SprintVelocityResponse)
async def get_sprint_velocity(
    sprint_id: uuid.UUID,
    repo: AnalyticsRepository = Depends(_get_repo),
) -> SprintVelocityResponse:
    data = await repo.get_sprint_velocity(sprint_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintVelocityResponse.model_validate(data)
