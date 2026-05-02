import uuid
from datetime import datetime

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.pm import Story, StoryActivity, StoryComment
from app.repositories.story import StoryRepository
from app.schemas.story import StoryCreate, StoryResponse, StoryStatusUpdate, StoryUpdate

router = APIRouter(prefix="/api/v2/stories", tags=["stories"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> StoryRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return StoryRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[StoryResponse])
async def list_stories(
    project_id: uuid.UUID | None = Query(default=None),
    epic_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    assignee_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: StoryRepository = Depends(_get_repo),
) -> list[StoryResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if epic_id:
        filters["epic_id"] = epic_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    if assignee_id:
        filters["assignee_id"] = assignee_id
    if status_filter:
        filters["status"] = status_filter
    stories = await repo.list(**filters)
    return [StoryResponse.model_validate(s) for s in stories]


@router.post("", response_model=StoryResponse, status_code=201)
async def create_story(
    body: StoryCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> StoryResponse:
    repo = StoryRepository(session, body.org_id)
    story = await repo.create(
        project_id=body.project_id,
        title=body.title,
        epic_id=body.epic_id,
        sprint_id=body.sprint_id,
        assignee_id=body.assignee_id,
        meeting_id=body.meeting_id,
        status=body.status,
        priority=body.priority,
        story_points=body.story_points,
        description=body.description,
        acceptance_criteria=body.acceptance_criteria,
        position=body.position,
    )
    return StoryResponse.model_validate(story)


@router.get("/{id}", response_model=StoryResponse)
async def get_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
) -> StoryResponse:
    story = await repo.get(id)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    return StoryResponse.model_validate(story)


@router.patch("/{id}", response_model=StoryResponse)
async def update_story(
    id: uuid.UUID,
    body: StoryUpdate,
    repo: StoryRepository = Depends(_get_repo),
) -> StoryResponse:
    data = body.model_dump(exclude_unset=True)
    story = await repo.update(id, **data)
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    return StoryResponse.model_validate(story)


@router.delete("/{id}", status_code=200)
async def delete_story(
    id: uuid.UUID,
    repo: StoryRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Story not found")
    return {"ok": True}


@router.patch("/{id}/status", response_model=StoryResponse)
async def update_story_status(
    id: uuid.UUID,
    body: StoryStatusUpdate,
    repo: StoryRepository = Depends(_get_repo),
) -> StoryResponse:
    try:
        story = await repo.set_status(id, body.status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return StoryResponse.model_validate(story)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class CommentResponse(BaseModel):
    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class ActivityResponse(BaseModel):
    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    activity_type: str
    old_value: str | None = None
    new_value: str | None = None
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class BulkUpdateItem(BaseModel):
    id: uuid.UUID
    status: str | None = None
    sprint_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    priority: str | None = None
    position: int | None = None


# ─── Comments ─────────────────────────────────────────────────────────────────

@router.get("/{id}/comments", response_model=list[CommentResponse])
async def list_comments(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _repo: StoryRepository = Depends(_get_repo),
) -> list[CommentResponse]:
    q = select(StoryComment).where(
        StoryComment.story_id == id,
        StoryComment.deleted_at.is_(None),
    ).order_by(StoryComment.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [CommentResponse.model_validate(r) for r in result.scalars()]


@router.post("/{id}/comments", response_model=CommentResponse, status_code=201)
async def add_comment(
    id: uuid.UUID,
    content: str = Body(..., embed=True),
    created_by: uuid.UUID = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
) -> CommentResponse:
    story = await repo.get(id)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    comment = StoryComment(
        story_id=id,
        org_id=repo.org_id,
        project_id=story.project_id,
        content=content,
        created_by=created_by,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return CommentResponse.model_validate(comment)


# ─── Activities ───────────────────────────────────────────────────────────────

@router.get("/{id}/activities", response_model=list[ActivityResponse])
async def list_activities(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: StoryRepository = Depends(_get_repo),
) -> list[ActivityResponse]:
    q = select(StoryActivity).where(
        StoryActivity.story_id == id,
    ).order_by(StoryActivity.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [ActivityResponse.model_validate(r) for r in result.scalars()]


# ─── Bulk update ──────────────────────────────────────────────────────────────

@router.patch("/bulk", response_model=list[StoryResponse])
async def bulk_update_stories(
    items: list[BulkUpdateItem],
    db: AsyncSession = Depends(get_db),
    repo: StoryRepository = Depends(_get_repo),
) -> list[StoryResponse]:
    results: list[StoryResponse] = []
    for item in items:
        q = await db.execute(select(Story).where(Story.id == item.id))
        story = q.scalar_one_or_none()
        if not story:
            continue
        update_data = item.model_dump(exclude={"id"}, exclude_none=True)
        for k, v in update_data.items():
            setattr(story, k, v)
        results.append(StoryResponse.model_validate(story))
    await db.commit()
    return results
