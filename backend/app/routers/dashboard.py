import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.memo import Memo
from app.models.pm import Story, Task
from app.models.team import TeamMember
from app.schemas.dashboard import DashboardResponse, MemoItem, StoryItem, TaskItem

router = APIRouter(prefix="/api/v2/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse)
async def get_dashboard(
    member_id: uuid.UUID = Query(...),
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> DashboardResponse:
    if project_id is None:
        tm_r = await session.execute(
            select(TeamMember.project_id).where(
                TeamMember.id == member_id, TeamMember.is_active.is_(True)
            ).limit(1)
        )
        project_id = tm_r.scalar_one_or_none()
        if project_id is None:
            raise HTTPException(status_code=404, detail="Member not found or inactive")

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

    memos_r = await session.execute(
        select(Memo.id, Memo.title, Memo.status).where(
            Memo.project_id == project_id,
            Memo.assigned_to == member_id,
            Memo.status == "open",
            Memo.deleted_at.is_(None),
        )
    )
    memo_rows = memos_r.all()

    return DashboardResponse(
        my_stories=[StoryItem(id=r[0], title=r[1], status=r[2], story_points=r[3]) for r in story_rows],
        my_tasks=[TaskItem(id=r[0], title=r[1], status=r[2]) for r in task_rows],
        open_memos=[MemoItem(id=r[0], title=r[1], status=r[2]) for r in memo_rows],
    )
