import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story, Task
from app.models.team import TeamMember
from app.schemas.dashboard import DashboardResponse, StoryItem, TaskItem

router = APIRouter(prefix="/api/v2/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse)
async def get_dashboard(
    member_id: uuid.UUID = Query(...),
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> DashboardResponse:
    """prod 핫픽스(S20 전수스캔 MUST): cross-org 데이터 누출 차단.

    이전엔 org_id 검증 자체가 없어(get_verified_org_id 미호출) 임의 member_id로 타 org 멤버의
    대시보드(할당 스토리/태스크)를 그대로 열람할 수 있었다 — `project_id`를 명시하면 member 조회
    자체가 생략돼 더 심했다. member가 caller org 소속인지 항상 검증(project_id 명시 여부 무관).
    assignee 기준 열람 자체는 stories/tasks 목록 필터와 동일한 프로젝트 협업 시야라 자기 자신으로
    제한하지 않는다(PO 확인).
    """
    member_check = await session.execute(
        select(TeamMember.project_id).where(
            TeamMember.id == member_id, TeamMember.org_id == org_id, TeamMember.is_active.is_(True)
        ).limit(1)
    )
    member_project_id = member_check.scalar_one_or_none()
    if member_project_id is None:
        raise HTTPException(status_code=404, detail="Member not found or inactive")
    if project_id is None:
        project_id = member_project_id

    stories_r = await session.execute(
        select(Story.id, Story.title, Story.status, Story.story_points).where(
            Story.project_id == project_id,
            Story.assignee_id == member_id,
            Story.status != "done",
            Story.deleted_at.is_(None),
        )
    )
    story_rows = stories_r.all()

    tasks_r = await session.execute(
        select(Task.id, Task.title, Task.status).where(
            Task.assignee_id == member_id,
            Task.status != "done",
            Task.deleted_at.is_(None),
        )
    )
    task_rows = tasks_r.all()

    return DashboardResponse(
        my_stories=[StoryItem(id=r[0], title=r[1], status=r[2], story_points=r[3]) for r in story_rows],
        my_tasks=[TaskItem(id=r[0], title=r[1], status=r[2]) for r in task_rows],
        open_memos=[],
    )
