import uuid
from datetime import date as date_type

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.pm import Story
from app.models.standup import StandupEntry
from app.models.team import TeamMember
from app.repositories.sprint import SprintRepository
from app.schemas.sprint import KickoffBody, SprintCreate, SprintResponse, SprintUpdate

router = APIRouter(prefix="/api/v2/sprints", tags=["sprints"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> SprintRepository:
    org_id_str = (
        auth.claims.get("app_metadata", {}).get("org_id")
        or x_org_id
    )
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required (X-Org-Id header or JWT app_metadata)")
    return SprintRepository(session, uuid.UUID(str(org_id_str)))


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
) -> SprintResponse:
    repo = SprintRepository(session, body.org_id)
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
) -> SprintResponse:
    try:
        sprint = await repo.close(id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
