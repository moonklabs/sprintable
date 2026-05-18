import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.repositories.task import TaskRepository
from app.schemas.task import TaskCreate, TaskResponse, TaskUpdate
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/tasks", tags=["tasks"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskRepository:
    return TaskRepository(session, org_id)


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    story_id: uuid.UUID | None = Query(default=None),
    assignee_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: TaskRepository = Depends(_get_repo),
) -> list[TaskResponse]:
    filters: dict = {}
    if story_id:
        filters["story_id"] = story_id
    if assignee_id:
        filters["assignee_id"] = assignee_id
    if status_filter:
        filters["status"] = status_filter
    tasks = await repo.list(**filters)
    return [TaskResponse.model_validate(t) for t in tasks]


@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(
    body: TaskCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TaskResponse:
    enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
    )
    repo = TaskRepository(session, org_id)
    task = await repo.create(
        story_id=body.story_id,
        title=body.title,
        assignee_id=body.assignee_id,
        status=body.status,
        story_points=body.story_points,
    )
    return TaskResponse.model_validate(task)


@router.get("/{id}", response_model=TaskResponse)
async def get_task(
    id: uuid.UUID,
    repo: TaskRepository = Depends(_get_repo),
) -> TaskResponse:
    task = await repo.get(id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse.model_validate(task)


@router.patch("/{id}", response_model=TaskResponse)
async def update_task(
    id: uuid.UUID,
    body: TaskUpdate,
    repo: TaskRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    task_before = await repo.get(id)
    old_status = task_before.status if task_before else None
    data = body.model_dump(exclude_unset=True)
    task = await repo.update(id, **data)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    # E-EVENTBUS P3 S9: task_completed → story assignee에게 알림
    if old_status != "done" and task.status == "done" and task.story_id:
        story_result = await db.execute(
            select(Story.assignee_id, Story.title, Story.org_id).where(Story.id == task.story_id)
        )
        story_row = story_result.one_or_none()
        if story_row and story_row.assignee_id:
            await dispatch_notification(
                db,
                org_id=repo.org_id,
                event_type="task_completed",
                target_member_ids=[story_row.assignee_id],
                title=f"태스크 완료: {task.title}",
                body=f"스토리: {story_row.title}" if story_row.title else None,
                reference_type="task",
                reference_id=task.id,
            )
    return TaskResponse.model_validate(task)


@router.delete("/{id}", status_code=200)
async def delete_task(
    id: uuid.UUID,
    repo: TaskRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"ok": True}
