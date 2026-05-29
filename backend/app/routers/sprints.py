import uuid
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.models.standup import StandupEntry
from app.models.team import TeamMember
from app.repositories.sprint import SprintRepository
from app.schemas.sprint import KickoffBody, SprintCreate, SprintResponse, SprintUpdate
from app.services.notification_dispatch import dispatch_notification

router = APIRouter(prefix="/api/v2/sprints", tags=["sprints"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SprintRepository:
    return SprintRepository(session, org_id)


@router.get("", response_model=list[SprintResponse])
async def list_sprints(
    project_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: SprintRepository = Depends(_get_repo),
) -> list[SprintResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if status_filter:
        filters["status"] = status_filter
    sprints = await repo.list(**filters)
    return [SprintResponse.model_validate(s) for s in sprints]


@router.post("", response_model=SprintResponse, status_code=201)
async def create_sprint(
    body: SprintCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> SprintResponse:
    repo = SprintRepository(session, org_id)
    sprint = await repo.create(
        project_id=body.project_id,
        title=body.title,
        start_date=body.start_date,
        end_date=body.end_date,
        team_size=body.team_size,
    )
    return SprintResponse.model_validate(sprint)


@router.get("/{id}", response_model=SprintResponse)
async def get_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
) -> SprintResponse:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintResponse.model_validate(sprint)


@router.patch("/{id}", response_model=SprintResponse)
async def update_sprint(
    id: uuid.UUID,
    body: SprintUpdate,
    repo: SprintRepository = Depends(_get_repo),
) -> SprintResponse:
    data = body.model_dump(exclude_unset=True)
    sprint = await repo.update(id, **data)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return SprintResponse.model_validate(sprint)


@router.delete("/{id}", status_code=200)
async def delete_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Sprint not found")
    return {"ok": True}


@router.post("/{id}/activate", response_model=SprintResponse)
async def activate_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
) -> SprintResponse:
    try:
        sprint = await repo.activate(id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SprintResponse.model_validate(sprint)


@router.post("/{id}/close", response_model=SprintResponse)
async def close_sprint(
    id: uuid.UUID,
    repo: SprintRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
) -> SprintResponse:
    try:
        sprint = await repo.close(id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # E-EVENTBUS P3 S9: sprint_closed → 프로젝트 전체 active 멤버에게 알림
    if sprint.project_id:
        members_result = await db.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == sprint.project_id,
                TeamMember.is_active.is_(True),
                TeamMember.type == "human",
            )
        )
        member_ids = [row[0] for row in members_result.all()]
        if member_ids:
            await dispatch_notification(
                db,
                org_id=repo.org_id,
                event_type="sprint_closed",
                target_member_ids=member_ids,
                title=f"스프린트 종료: {sprint.title}",
                body=None,
                reference_type="sprint",
                reference_id=sprint.id,
            )
    return SprintResponse.model_validate(sprint)


@router.post("/{id}/kickoff")
async def kickoff_sprint(
    id: uuid.UUID,
    body: KickoffBody = KickoffBody(),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")
    # Notification dispatch is Phase D — return stub for Phase B
    return {"notified": 0, "sprint_id": str(id), "message": body.message}


@router.get("/{id}/summary")
async def sprint_summary(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    """GET /api/v2/sprints/{id}/summary — 스프린트 스토리 상태별 집계 (AC3 S-STANDUP-FIX)."""
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")

    stories_result = await db.execute(
        select(Story.status, Story.story_points).where(Story.sprint_id == id)
    )
    stories = stories_result.all()

    status_counts: dict[str, int] = {}
    status_points: dict[str, int] = {}
    for s in stories:
        status_counts[s.status] = status_counts.get(s.status, 0) + 1
        status_points[s.status] = status_points.get(s.status, 0) + (s.story_points or 0)

    total_stories = len(stories)
    total_points = sum(s.story_points or 0 for s in stories)
    done_points = status_points.get("done", 0)
    completion_pct = round((done_points / total_points) * 100) if total_points > 0 else 0

    return {
        "sprint_id": str(id),
        "total_stories": total_stories,
        "total_points": total_points,
        "done_points": done_points,
        "completion_pct": completion_pct,
        "by_status": {
            status: {"count": status_counts.get(status, 0), "points": status_points.get(status, 0)}
            for status in ["todo", "in_progress", "review", "done", "blocked"]
        },
    }


@router.get("/{id}/checkin")
async def checkin_sprint(
    id: uuid.UUID,
    date: str = Query(..., description="YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    repo: SprintRepository = Depends(_get_repo),
) -> dict:
    sprint = await repo.get(id)
    if sprint is None:
        raise HTTPException(status_code=404, detail="Sprint not found")

    try:
        checkin_date = date_type.fromisoformat(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid date format, expected YYYY-MM-DD") from exc

    stories_result = await db.execute(
        select(Story.status, Story.story_points).where(Story.sprint_id == id)
    )
    stories = stories_result.all()

    members_result = await db.execute(
        select(TeamMember.id, TeamMember.name).where(
            TeamMember.project_id == sprint.project_id,
            TeamMember.is_active.is_(True),
        )
    )
    members = members_result.all()

    standup_result = await db.execute(
        select(StandupEntry.author_id).where(
            StandupEntry.project_id == sprint.project_id,
            StandupEntry.date == checkin_date,
        )
    )
    standup_author_ids = {row.author_id for row in standup_result}

    total_stories = len(stories)
    total_points = sum(s.story_points or 0 for s in stories)
    done_points = sum(s.story_points or 0 for s in stories if s.status == "done")
    completion_pct = round((done_points / total_points) * 100) if total_points > 0 else 0
    missing_standups = [
        {"id": str(m.id), "name": m.name}
        for m in members
        if m.id not in standup_author_ids
    ]

    return {
        "total_stories": total_stories,
        "total_points": total_points,
        "done_points": done_points,
        "completion_pct": completion_pct,
        "missing_standups": missing_standups,
    }
