import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.repositories.team_member import TeamMemberRepository
from app.schemas.team_member import TeamMemberCreate, TeamMemberResponse, TeamMemberUpdate

router = APIRouter(prefix="/api/v2/team-members", tags=["team-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TeamMemberRepository:
    return TeamMemberRepository(session, org_id)


@router.get("", response_model=list[TeamMemberResponse])
async def list_team_members(
    project_id: uuid.UUID | None = Query(default=None),
    type_filter: str | None = Query(default=None, alias="type"),
    is_active: bool | None = Query(default=True),
    repo: TeamMemberRepository = Depends(_get_repo),
) -> list[TeamMemberResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if type_filter:
        filters["type"] = type_filter
    if is_active is not None:
        filters["is_active"] = is_active
    members = await repo.list(**filters)
    return [TeamMemberResponse.model_validate(m) for m in members]


@router.post("", response_model=TeamMemberResponse, status_code=201)
async def create_team_member(
    body: TeamMemberCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> TeamMemberResponse:
    repo = TeamMemberRepository(session, body.org_id)
    created_by = uuid.UUID(auth.user_id) if body.type == "agent" else None
    member = await repo.create(
        project_id=body.project_id,
        type=body.type,
        name=body.name,
        role=body.role,
        user_id=body.user_id,
        avatar_url=body.avatar_url,
        agent_config=body.agent_config,
        webhook_url=body.webhook_url,
        color=body.color,
        agent_role=body.agent_role,
        created_by=created_by,
    )
    return TeamMemberResponse.model_validate(member)


@router.get("/{id}", response_model=TeamMemberResponse)
async def get_team_member(
    id: uuid.UUID,
    repo: TeamMemberRepository = Depends(_get_repo),
) -> TeamMemberResponse:
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    return TeamMemberResponse.model_validate(member)


@router.patch("/{id}", response_model=TeamMemberResponse)
async def update_team_member(
    id: uuid.UUID,
    body: TeamMemberUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TeamMemberResponse:
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    if member.type == "agent":
        await assert_agent_owner(id, session, org_id, uuid.UUID(auth.user_id))
    data = body.model_dump(exclude_unset=True)
    updated = await repo.update(id, **data)
    return TeamMemberResponse.model_validate(updated)


@router.delete("/{id}", status_code=200)
async def deactivate_team_member(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    if member.type == "agent":
        await assert_agent_owner(id, session, org_id, uuid.UUID(auth.user_id))
    ok = await repo.deactivate(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Team member not found")
    return {"ok": True, "deactivated": True}
