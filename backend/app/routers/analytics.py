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
    EpicFlowNodesBatchResponse,
    EpicFlowNodesResponse,
    EpicProgressLane,
    EpicProgressResponse,
    EpicsProgressLaneResponse,
    EpicZoneCounts,
    GoalEdge,
    MemberWorkloadResponse,
    PendingCandidateCountResponse,
    ProjectHealthResponse,
    ProjectOverviewResponse,
    RecentActivityResponse,
    SprintVelocityItem,
    SprintVelocityResponse,
)
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2", tags=["analytics", "Work"])


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


@router.get("/analytics/epics-progress-lane", response_model=EpicsProgressLaneResponse)
async def get_epics_progress_lane(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> EpicsProgressLaneResponse:
    """story #2224(S2-1, 갈래 화면) 좌측 레인 — project 전체 에픽의 진행/대기/막힘/멈춤을
    «한 번의 호출»로 낸다(미르코 실측 갭: EpicProgressResponse엔 이 네 칸이 없었다)."""
    await _assert_project_access(repo, auth, project_id)
    result = await repo.get_epics_progress_lane(project_id)
    return EpicsProgressLaneResponse(
        epics={k: EpicProgressLane.model_validate(v) for k, v in result["lanes"].items()},
        zones={k: EpicZoneCounts.model_validate(v) for k, v in result["zones"].items()},
        stall_threshold_hours=168,
        stories_without_epic=result["stories_without_epic"],
    )


@router.get("/analytics/epic-flow-nodes")
async def get_epic_flow_nodes(
    project_id: uuid.UUID = Query(...),
    epic_id: uuid.UUID | None = Query(default=None),
    epic_ids: str | None = Query(default=None, description="콤마구분 UUID 목록(story #2679 배치)"),
    upcoming_limit: int = Query(default=15, ge=1, le=100),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> EpicFlowNodesResponse | EpicFlowNodesBatchResponse:
    """story #2224 노드 계약(급전환, 2026-07-30 PO 판정) — 「지금/이어질/지나온」 세 구역
    노드를 «에픽 하나» 단위로 한 번의 호출로 낸다(179 에픽 전체를 한 번에 주면 수천 건이라
    안 준다 — 펼친 에픽만). `upcoming_limit`은 FE 화면 상한(PO 감 10~15, 기본 15).

    story #2679(2026-07-30, PO 급요청) — L3 캔버스가 여러 레인을 한 화면에 동시에 그리며
    이 «에픽 하나» 계약이 레인 수만큼 호출을 요구하게 됐다(오늘 금지한 패턴). `epic_ids`
    (콤마구분)로 여러 에픽을 한 번에 받는다 — FE가 이미 아는 epic_id 목록을 넘긴다(lane과
    다른 정렬을 새로 판정하지 않는다, PO 판정). `epic_id`·`epic_ids` 중 정확히 하나만."""
    await _assert_project_access(repo, auth, project_id)
    if (epic_id is None) == (epic_ids is None):
        raise HTTPException(status_code=400, detail="epic_id 또는 epic_ids 중 정확히 하나를 지정하십시오")
    if epic_id is not None:
        result = await repo.get_epic_flow_nodes(project_id, epic_id, upcoming_limit)
        return EpicFlowNodesResponse.model_validate(result)

    try:
        parsed_ids = [uuid.UUID(s.strip()) for s in epic_ids.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="epic_ids는 콤마구분 UUID 목록이어야 합니다")
    if not parsed_ids:
        raise HTTPException(status_code=400, detail="epic_ids가 비어 있습니다")
    batch_result = await repo.get_epic_flow_nodes_batch(project_id, parsed_ids, upcoming_limit)
    return EpicFlowNodesBatchResponse.model_validate(batch_result)


@router.get("/analytics/goal-edges", response_model=list[GoalEdge])
async def get_goal_edges(
    project_id: uuid.UUID = Query(...),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[GoalEdge]:
    """story #2360 — 목표(에픽) 간 「낳음」 연결을 목표 쌍 단위로 집계해 낸다. 지금까지는
    `GET /stories/{id}/backlinks`(스토리 한 건씩)로만 읽혀 목표 간 선 하나에 스토리 수만큼
    콜이 들었다 — 이 엔드포인트는 스토리 수와 무관한 고정 쿼리로 대체한다(AC6).
    빈 배열은 「연결이 없다」이지 「못 읽었다」가 아니다 — 오류는 그대로 오류 코드로 난다."""
    await _assert_project_access(repo, auth, project_id)
    rows = await repo.get_goal_edges(project_id)
    return [GoalEdge.model_validate(r) for r in rows]


@router.get("/analytics/goal-edges/pending-count", response_model=PendingCandidateCountResponse)
async def get_pending_candidate_count(
    project_id: uuid.UUID = Query(...),
    epic_ids: str = Query(..., description="콤마구분 UUID 목록 — 화면이 지금 그리는 레인 집합"),
    repo: AnalyticsRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> PendingCandidateCountResponse:
    """story #2366 — 주어진 목표(epic) 집합 «안에서» 확認 대기 중인 후보 쌍 수를 낸다.
    ⛔`goal-edges`(바로 위)가 세는 축(`status='declared'`)은 안 건드린다 — 이 엔드포인트는
    별도다(#2360 AC3 "자동 확定 금지"의 대가를 estimated를 확定된 연결처럼 세는 방식으로
    깨지 않는다). `epic_ids`는 프로젝트 전체가 아니라 «화면이 지금 렌더 중인» 레인 집합
    이다 — 프로젝트 전체 수가 필요하면 이 엔드포인트가 아니라 별도 판단이 필요하다."""
    await _assert_project_access(repo, auth, project_id)
    try:
        parsed_ids = [uuid.UUID(s.strip()) for s in epic_ids.split(",") if s.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="epic_ids는 콤마구분 UUID 목록이어야 합니다")
    if not parsed_ids:
        raise HTTPException(status_code=400, detail="epic_ids가 비어 있습니다")
    result = await repo.get_pending_candidate_count(project_id, parsed_ids)
    return PendingCandidateCountResponse.model_validate(result)


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
