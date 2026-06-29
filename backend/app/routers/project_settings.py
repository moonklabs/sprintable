import uuid
from datetime import time

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project_setting import ProjectSetting
from app.schemas.project_setting import ProjectSettingResponse, UpdateProjectSetting
from app.services.project_auth import has_project_access, has_project_role

router = APIRouter(prefix="/api/v2/project-settings", tags=["project-settings"])

_DEFAULT_DEADLINE = time(9, 0)


@router.get("", response_model=ProjectSettingResponse)
async def get_project_settings(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ProjectSettingResponse:
    # E-MEMBER-POLICY(9b8d634b): 프로젝트 멤버만 열람 — cross-tenant read 차단(타 org 프로젝트 settings 노출 방지).
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=403, detail="project access required")
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
    auth: AuthContext = Depends(get_current_user),
) -> ProjectSettingResponse:
    # E-MEMBER-POLICY(9b8d634b·정책 §2): 설정 변경 = project owner/admin(has_project_role 이 org owner/admin
    # floor 포함). 기존 authz 0(누구나 타 프로젝트 standup_deadline 변경 가능)이던 보안 갭 차단.
    if not await has_project_role(
        session, uuid.UUID(auth.user_id), body.project_id, min_role="admin"
    ):
        raise HTTPException(status_code=403, detail="project owner/admin required")
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
