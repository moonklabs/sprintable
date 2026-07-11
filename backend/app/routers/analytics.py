import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Sprint
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
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2", tags=["analytics"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> AnalyticsRepository:
    return AnalyticsRepository(session, org_id)


async def _assert_project_access(repo: AnalyticsRepository, auth: AuthContext, project_id: uuid.UUID) -> None:
    """E-SECURITY SEC-S8(story 83ea3d6a) DD 후속: analytics.py 전 엔드포인트가 org_id는
    필터하나 caller의 project 접근권 검증이 없어 same-org 다른 project의 집계 데이터가
    노출됐다(오늘 R~CC와 동형)."""
    if not await has_project_access(repo.session, uuid.UUID(auth.user_id), project_id, repo.org_id):
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("/analytics/overview", response_model=ProjectOverviewResponse)
async def get_overview(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> ProjectOverviewResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_overview(project_id)
    return ProjectOverviewResponse.model_validate(data)


@router.get("/analytics/workload", response_model=MemberWorkloadResponse)
async def get_member_workload(
    project_id: uuid.UUID = Query(...),
    member_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> MemberWorkloadResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_member_workload(project_id, member_id)
    return MemberWorkloadResponse.model_validate(data)


@router.get("/analytics/velocity-history", response_model=list[SprintVelocityItem])
async def get_velocity_history(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[SprintVelocityItem]:
    await _assert_project_access(repo, auth, project_id)
    items = await repo.get_velocity_history(project_id)
    return [SprintVelocityItem.model_validate(i) for i in items]


@router.get("/analytics/activity", response_model=RecentActivityResponse)
async def get_recent_activity(
    project_id: uuid.UUID = Query(...),
    limit: int = Query(default=10, ge=1, le=100),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> RecentActivityResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_recent_activity(project_id, limit)
    return RecentActivityResponse.model_validate(data)


@router.get("/analytics/epic-progress", response_model=EpicProgressResponse)
async def get_epic_progress(
    project_id: uuid.UUID = Query(...),
    epic_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> EpicProgressResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_epic_progress(project_id, epic_id)
    return EpicProgressResponse.model_validate(data)


@router.get("/analytics/agent-stats", response_model=AgentStatsResponse)
async def get_agent_stats(
    project_id: uuid.UUID = Query(...),
    agent_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> AgentStatsResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_agent_stats(project_id, agent_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Agent not found in project")
    return AgentStatsResponse.model_validate(data)


@router.get("/analytics/health", response_model=ProjectHealthResponse)
async def get_project_health(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> ProjectHealthResponse:
    await _assert_project_access(repo, auth, project_id)
    data = await repo.get_project_health(project_id)
    return ProjectHealthResponse.model_validate(data)


@router.get("/sprints/{sprint_id}/burndown", response_model=BurndownResponse)
async def get_burndown(
    sprint_id: uuid.UUID,
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> BurndownResponse:
    sprint_project_id = (await repo.session.execute(
        select(Sprint.project_id).where(Sprint.id == sprint_id, Sprint.org_id == repo.org_id)
    )).scalar_one_or_none()
    if sprint_project_id is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    await _assert_project_access(repo, auth, sprint_project_id)
    data = await repo.get_burndown(sprint_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return BurndownResponse.model_validate(data)


@router.get("/sprints/{sprint_id}/velocity", response_model=SprintVelocityResponse)
async def get_sprint_velocity(
    sprint_id: uuid.UUID,
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> SprintVelocityResponse:
    sprint_project_id = (await repo.session.execute(
        select(Sprint.project_id).where(Sprint.id == sprint_id, Sprint.org_id == repo.org_id)
    )).scalar_one_or_none()
    if sprint_project_id is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    await _assert_project_access(repo, auth, sprint_project_id)
    data = await repo.get_sprint_velocity(sprint_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintVelocityResponse.model_validate(data)
