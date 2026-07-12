import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.repositories.participation import ParticipationRepository, ParticipationRoleRepository
from app.schemas.participation import ParticipationCreate, ParticipationResponse, ParticipationRoleResponse
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/participation", tags=["participation"])


async def _assert_story_project_access(
    session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID, story_id: uuid.UUID
) -> None:
    """participation은 story-bound다. story_id의 실 project 접근권을 resource-actual로 검증한다
    (body/query-claimed story_id를 믿지 않음). story가 caller org에 없거나 그 project 접근권이
    없으면 404(존재 비노출). round1~9/add_feedback와 동형 규율 — has_project_access 직접호출."""
    project_id = (
        await session.execute(
            select(Story.project_id).where(Story.id == story_id, Story.org_id == org_id)
        )
    ).scalar_one_or_none()
    if project_id is None or not await has_project_access(session, user_id, project_id, org_id):
        raise HTTPException(status_code=404, detail="Story not found")


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
    auth: AuthContext = Depends(get_current_user),
) -> ParticipationResponse:
    # write-path IDOR 봉인: body.story_id에 caller 접근권 검증 없이 임의 story에 participation을
    # 주입할 수 있었다(cross-project/org). resource-actual project-scope 가드.
    await _assert_story_project_access(repo.session, uuid.UUID(auth.user_id), repo.org_id, body.story_id)
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
    auth: AuthContext = Depends(get_current_user),
) -> list[ParticipationResponse]:
    # read exposure 봉인: 접근권 없는 story의 participation 로스터 열람 차단.
    await _assert_story_project_access(repo.session, uuid.UUID(auth.user_id), repo.org_id, story_id)
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
