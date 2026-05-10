import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.task import TaskRepository
from app.schemas.task import TaskCreate, TaskResponse, TaskUpdate

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
    _auth: AuthContext = Depends(get_current_user),
) -> TaskResponse:
    repo = TaskRepository(session, body.org_id)
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
) -> TaskResponse:
    data = body.model_dump(exclude_unset=True)
    task = await repo.update(id, **data)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
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
