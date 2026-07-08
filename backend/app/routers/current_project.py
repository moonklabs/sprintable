import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.models.team import TeamMember
from app.schemas.current_project import CurrentProjectResponse, SetCurrentProject
from app.services.member_resolver import assert_caller_is_member

router = APIRouter(prefix="/api/v2/current-project", tags=["current-project"])


@router.get("", response_model=CurrentProjectResponse)
async def get_current_project(
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
    """S20(authz-coverage 스캐너 발견 — S19 Phase C서 no-op으로 skip 판단했던 그 오라클):
    member_id로 임의 member의 project_id/org_id/project_name을 caller-ownership 검증 없이
    조회할 수 있었다(membership-existence 오라클). self-scope 추가."""
    await assert_caller_is_member(member_id, auth, session, org_id)
    tm_r = await session.execute(
        select(TeamMember.project_id, TeamMember.org_id).where(
            TeamMember.id == member_id, TeamMember.is_active.is_(True)
        ).limit(1)
    )
    row = tm_r.first()
    if row is None:
        return CurrentProjectResponse(project_id=None, project_name=None, org_id=None)

    proj_r = await session.execute(
        select(Project.name).where(Project.id == row[0])
    )
    project_name = proj_r.scalar_one_or_none()

    return CurrentProjectResponse(
        project_id=row[0],
        project_name=project_name,
        org_id=row[1],
    )


@router.post("", response_model=CurrentProjectResponse)
async def set_current_project(
    body: SetCurrentProject,
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
    """S20(산티아고 재확인 대상 — S19 Phase C서 no-op으로 skip 판단했던 그 오라클을 authz-coverage
    스캐너가 재발견): member_id가 caller 본인인지 검증 없이 임의 member의 project 전환 결과
    (project_name/org_id)를 열람할 수 있었다. self-scope 추가."""
    await assert_caller_is_member(member_id, auth, session, org_id)
    tm_r = await session.execute(
        select(TeamMember.org_id).where(
            TeamMember.id == member_id,
            TeamMember.project_id == body.project_id,
            TeamMember.is_active.is_(True),
        )
    )
    org_id = tm_r.scalar_one_or_none()
    if org_id is None:
        raise HTTPException(status_code=403, detail="Project membership not found")

    proj_r = await session.execute(
        select(Project.name).where(Project.id == body.project_id)
    )
    project_name = proj_r.scalar_one_or_none()

    return CurrentProjectResponse(
        project_id=body.project_id,
        project_name=project_name,
        org_id=org_id,
    )
