import uuid
from datetime import time

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.project_setting import ProjectSetting
from app.schemas.project_setting import ProjectSettingResponse, UpdateProjectSetting

router = APIRouter(prefix="/api/v2/project-settings", tags=["project-settings"])

_DEFAULT_DEADLINE = time(9, 0)


@router.get("", response_model=ProjectSettingResponse)
async def get_project_settings(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> ProjectSettingResponse:
    result = await session.execute(
        select(ProjectSetting).where(ProjectSetting.project_id == project_id)
    )
    setting = result.scalar_one_or_none()
    if setting is None:
        from datetime import datetime, timezone
        return ProjectSettingResponse(
            project_id=project_id,
            standup_deadline=_DEFAULT_DEADLINE,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
    return ProjectSettingResponse.model_validate(setting)


@router.patch("", response_model=ProjectSettingResponse)
async def upsert_project_settings(
    body: UpdateProjectSetting,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> ProjectSettingResponse:
    deadline = time.fromisoformat(body.standup_deadline)
    result = await session.execute(
        select(ProjectSetting).where(ProjectSetting.project_id == body.project_id)
    )
    setting = result.scalar_one_or_none()
    if setting is None:
        setting = ProjectSetting(project_id=body.project_id, standup_deadline=deadline)
        session.add(setting)
    else:
        setting.standup_deadline = deadline
    await session.flush()
    await session.refresh(setting)
    return ProjectSettingResponse.model_validate(setting)
