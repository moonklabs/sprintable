import uuid
from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.standup import StandupEntry, StandupFeedback
from app.repositories.standup import StandupEntryRepository, StandupFeedbackRepository
from app.schemas.standup import (
    FeedbackCreate,
    FeedbackResponse,
    StandupEntryResponse,
    StandupUpsert,
)

router = APIRouter(prefix="/api/v2/standups", tags=["standups"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> StandupEntryRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return StandupEntryRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[StandupEntryResponse])
async def list_standups(
    project_id: uuid.UUID | None = Query(default=None),
    author_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    date_filter: date | None = Query(default=None, alias="date"),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[StandupEntryResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if author_id:
        filters["author_id"] = author_id
    if sprint_id:
        filters["sprint_id"] = sprint_id
    if date_filter:
        filters["date"] = date_filter
    entries = await repo.list(**filters)
    return [StandupEntryResponse.model_validate(e) for e in entries]


@router.post("", response_model=StandupEntryResponse, status_code=201)
async def upsert_standup(
    body: StandupUpsert,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> StandupEntryResponse:
    repo = StandupEntryRepository(session, body.org_id)
    entry = await repo.upsert(
        project_id=body.project_id,
        author_id=body.author_id,
        date=body.date,
        sprint_id=body.sprint_id,
        done=body.done,
        plan=body.plan,
        blockers=body.blockers,
        plan_story_ids=body.plan_story_ids,
    )
    return StandupEntryResponse.model_validate(entry)


@router.get("/missing", response_model=list[uuid.UUID])
async def get_missing_standups(
    project_id: uuid.UUID = Query(...),
    date_filter: date = Query(..., alias="date"),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[uuid.UUID]:
    return await repo.get_missing(project_id, date_filter)


@router.get("/feedback", response_model=list[FeedbackResponse])
async def list_feedback(
    project_id: uuid.UUID = Query(...),
    date_filter: date = Query(..., alias="date"),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> list[FeedbackResponse]:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    org_id = uuid.UUID(str(org_id_str))

    q = (
        select(StandupFeedback)
        .join(StandupEntry, StandupFeedback.standup_entry_id == StandupEntry.id)
        .where(
            StandupFeedback.project_id == project_id,
            StandupFeedback.org_id == org_id,
            StandupEntry.date == date_filter,
        )
    )
    result = await db.execute(q)
    return [FeedbackResponse.model_validate(f) for f in result.scalars()]


@router.get("/{id}", response_model=StandupEntryResponse)
async def get_standup(
    id: uuid.UUID,
    repo: StandupEntryRepository = Depends(_get_repo),
) -> StandupEntryResponse:
    entry = await repo.get(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Standup entry not found")
    return StandupEntryResponse.model_validate(entry)


@router.post("/{id}/feedback", response_model=FeedbackResponse, status_code=201)
async def add_feedback(
    id: uuid.UUID,
    body: FeedbackCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> FeedbackResponse:
    from app.schemas.standup import REVIEW_TYPES
    if body.review_type not in REVIEW_TYPES:
        raise HTTPException(status_code=400, detail=f"review_type must be one of: {', '.join(REVIEW_TYPES)}")

    entry_repo = StandupEntryRepository(session, body.org_id)
    entry = await entry_repo.get(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Standup entry not found")

    fb_repo = StandupFeedbackRepository(session, body.org_id)
    feedback = await fb_repo.create(
        project_id=body.project_id,
        sprint_id=body.sprint_id,
        standup_entry_id=id,
        feedback_by_id=body.feedback_by_id,
        review_type=body.review_type,
        feedback_text=body.feedback_text,
    )
    return FeedbackResponse.model_validate(feedback)
