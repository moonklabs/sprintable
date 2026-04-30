import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.project import Project
from app.models.team import TeamMember
from app.schemas.current_project import CurrentProjectResponse, SetCurrentProject

router = APIRouter(prefix="/api/v2/current-project", tags=["current-project"])


@router.get("", response_model=CurrentProjectResponse)
async def get_current_project(
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
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
    _auth: AuthContext = Depends(get_current_user),
) -> CurrentProjectResponse:
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
