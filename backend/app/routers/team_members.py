import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.team_member import TeamMemberRepository
from app.schemas.team_member import TeamMemberCreate, TeamMemberResponse, TeamMemberUpdate

router = APIRouter(prefix="/api/v2/team-members", tags=["team-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> TeamMemberRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return TeamMemberRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[TeamMemberResponse])
async def list_team_members(
    project_id: uuid.UUID | None = Query(default=None),
    type_filter: str | None = Query(default=None, alias="type"),
    is_active: bool | None = Query(default=None),
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
    _auth: AuthContext = Depends(get_current_user),
) -> TeamMemberResponse:
    repo = TeamMemberRepository(session, body.org_id)
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
    repo: TeamMemberRepository = Depends(_get_repo),
) -> TeamMemberResponse:
    data = body.model_dump(exclude_unset=True)
    member = await repo.update(id, **data)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    return TeamMemberResponse.model_validate(member)


@router.delete("/{id}", status_code=200)
async def deactivate_team_member(
    id: uuid.UUID,
    repo: TeamMemberRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.deactivate(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Team member not found")
    return {"ok": True, "deactivated": True}
