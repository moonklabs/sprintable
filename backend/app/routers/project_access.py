"""project_access CRUD API — 프로젝트별 접근 제어 (E-ENTITY-CLEANUP S4)."""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.project_access import ProjectAccess
from app.repositories.organization import OrganizationRepository

router = APIRouter(prefix="/api/v2/projects", tags=["project-access"])


class ProjectAccessCreate(BaseModel):
    org_member_id: uuid.UUID
    permission: str = "denied"


class ProjectAccessResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_member_id: uuid.UUID
    permission: str
    created_at: datetime


def _get_org_repo(session: AsyncSession = Depends(get_db)) -> OrganizationRepository:
    return OrganizationRepository(session)


async def _require_owner_or_admin(
    project_id: uuid.UUID, auth: AuthContext, session: AsyncSession
) -> None:
    """project_id → org_id 역추적 후 owner/admin 확인."""
    from sqlalchemy import text
    result = await session.execute(
        text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"),
        {"pid": str(project_id)},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    org_id = row[0]
    repo = OrganizationRepository(session)
    role = await repo.get_member_role(org_id=org_id, user_id=uuid.UUID(auth.user_id))
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="owner or admin role required")


@router.get("/{project_id}/access", response_model=list[ProjectAccessResponse])
async def list_project_access(
    project_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[ProjectAccessResponse]:
    """프로젝트 접근 제어 레코드 목록 — owner/admin만."""
    await _require_owner_or_admin(project_id, auth, session)
    result = await session.execute(
        select(ProjectAccess).where(ProjectAccess.project_id == project_id)
    )
    return [ProjectAccessResponse.model_validate(r) for r in result.scalars().all()]


@router.post("/{project_id}/access", response_model=ProjectAccessResponse, status_code=201)
async def create_project_access(
    project_id: uuid.UUID,
    body: ProjectAccessCreate,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ProjectAccessResponse:
    """프로젝트 접근 제어 레코드 생성 (기본 permission=blocked) — owner/admin만."""
    await _require_owner_or_admin(project_id, auth, session)
    if body.permission not in ("allowed", "denied"):
        raise HTTPException(status_code=400, detail="permission must be 'allowed' or 'denied'")
    existing = await session.execute(
        select(ProjectAccess).where(
            ProjectAccess.project_id == project_id,
            ProjectAccess.org_member_id == body.org_member_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="Access record already exists")
    record = ProjectAccess(
        project_id=project_id,
        org_member_id=body.org_member_id,
        permission=body.permission,
    )
    session.add(record)
    await session.commit()
    await session.refresh(record)
    return ProjectAccessResponse.model_validate(record)


@router.delete("/{project_id}/access/{record_id}", status_code=200)
async def delete_project_access(
    project_id: uuid.UUID,
    record_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """프로젝트 접근 제한 해제 — owner/admin만."""
    await _require_owner_or_admin(project_id, auth, session)
    result = await session.execute(
        select(ProjectAccess).where(
            ProjectAccess.id == record_id,
            ProjectAccess.project_id == project_id,
        )
    )
    record = result.scalar_one_or_none()
    if record is None:
        raise HTTPException(status_code=404, detail="Access record not found")
    await session.delete(record)
    await session.commit()
    return {"ok": True}
