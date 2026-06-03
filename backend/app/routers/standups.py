import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.standup import StandupEntry, StandupFeedback
from app.repositories.standup import StandupEntryRepository, StandupFeedbackRepository
from app.schemas.standup import (
    FeedbackCreate,
    FeedbackResponse,
    StandupEntryResponse,
    StandupSelfUpdate,
    StandupUpsert,
)
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/standups", tags=["standups"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryRepository:
    return StandupEntryRepository(session, org_id)


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
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryResponse:
    repo = StandupEntryRepository(session, org_id)
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


@router.put("", response_model=StandupEntryResponse)
async def update_standup(
    body: StandupSelfUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryResponse:
    """PUT /api/v2/standups — 본인 스탠드업 self-save (SID:6a1e8b1d).

    author_id는 인증 유저(resolve_member)에서 server-side 도출 — 클라 바디 author_id를
    받지 않아 타인 스탠드업 위조를 차단(본인만 수정). project_id는 바디 수용.
    author_id는 canonical member.id 방향(JWT 휴먼 → org_member.id, AC3-3 정합).
    """
    member = await resolve_member(auth, org_id, session, project_id=body.project_id)
    repo = StandupEntryRepository(session, org_id)
    entry = await repo.upsert(
        project_id=body.project_id,
        author_id=member.id,
        date=body.date,
        sprint_id=body.sprint_id,
        done=body.done,
        plan=body.plan,
        blockers=body.blockers,
        plan_story_ids=body.plan_story_ids,
    )
    return StandupEntryResponse.model_validate(entry)


@router.get("/history", response_model=list[StandupEntryResponse])
async def list_standup_history(
    project_id: uuid.UUID = Query(...),
    limit: int = Query(default=30, ge=1, le=200),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[StandupEntryResponse]:
    """GET /api/v2/standups/history — 최근 N개 스탠드업 히스토리 조회 (AC2 S-STANDUP-FIX)."""
    entries = await repo.list(project_id=project_id, limit=limit)
    return [StandupEntryResponse.model_validate(e) for e in entries]


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
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[FeedbackResponse]:
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
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> FeedbackResponse:
    from app.schemas.standup import REVIEW_TYPES
    if body.review_type not in REVIEW_TYPES:
        raise HTTPException(status_code=400, detail=f"review_type must be one of: {', '.join(REVIEW_TYPES)}")

    entry_repo = StandupEntryRepository(session, org_id)
    entry = await entry_repo.get(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Standup entry not found")

    fb_repo = StandupFeedbackRepository(session, org_id)
    feedback = await fb_repo.create(
        project_id=body.project_id,
        sprint_id=body.sprint_id,
        standup_entry_id=id,
        feedback_by_id=body.feedback_by_id,
        review_type=body.review_type,
        feedback_text=body.feedback_text,
    )
    return FeedbackResponse.model_validate(feedback)
