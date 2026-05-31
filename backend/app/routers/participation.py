import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.participation import ParticipationRepository, ParticipationRoleRepository
from app.schemas.participation import ParticipationCreate, ParticipationResponse, ParticipationRoleResponse

router = APIRouter(prefix="/api/v2/participation", tags=["participation"])


def _get_role_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ParticipationRoleRepository:
    return ParticipationRoleRepository(session, org_id)


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ParticipationRepository:
    return ParticipationRepository(session, org_id)


@router.get("/roles", response_model=list[ParticipationRoleResponse])
async def list_roles(
    repo: ParticipationRoleRepository = Depends(_get_role_repo),
    _auth=Depends(get_current_user),
) -> list[ParticipationRoleResponse]:
    roles = await repo.list()
    return [ParticipationRoleResponse.model_validate(r) for r in roles]


@router.post("", response_model=ParticipationResponse, status_code=201)
async def add_participation(
    body: ParticipationCreate,
    repo: ParticipationRepository = Depends(_get_repo),
    _auth=Depends(get_current_user),
) -> ParticipationResponse:
    if await repo.exists(body.story_id, body.member_id, body.role_id):
        raise HTTPException(status_code=409, detail="이미 존재하는 참여 기록")
    p = await repo.create(
        story_id=body.story_id,
        member_id=body.member_id,
        role_id=body.role_id,
    )
    return ParticipationResponse.model_validate(p)


@router.get("", response_model=list[ParticipationResponse])
async def list_participation(
    story_id: uuid.UUID = Query(...),
    repo: ParticipationRepository = Depends(_get_repo),
    _auth=Depends(get_current_user),
) -> list[ParticipationResponse]:
    items = await repo.list_by_story(story_id)
    return [ParticipationResponse.model_validate(i) for i in items]


@router.delete("/{id}", status_code=200)
async def remove_participation(
    id: uuid.UUID,
    repo: ParticipationRepository = Depends(_get_repo),
    _auth=Depends(get_current_user),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="참여 기록을 찾을 수 없음")
    return {"ok": True}
