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
    # 18073a52: 휴먼 grant = org_member_id / 에이전트 grant = member_id(=agent members.id). 정확히 1개 필수.
    org_member_id: uuid.UUID | None = None
    member_id: uuid.UUID | None = None
    permission: str = "granted"


class ProjectAccessResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    # nullable: migration 0075 가 NOT NULL 을 해제해 에이전트 direct placement(agents have no
    # org_member)를 수용한다. 스키마가 모델(Mapped[uuid.UUID | None])을 뒤따르지 못해 에이전트
    # 행 model_validate 시 ValidationError → GET /access 500 이던 것을 정합화한다.
    org_member_id: uuid.UUID | None = None
    # E-MEMBER-SSOT AC2-1 canonical 앵커 — 에이전트 행은 org_member_id 대신 member_id 로 식별.
    member_id: uuid.UUID | None = None
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
    """프로젝트 접근 grant 레코드 생성 (S-MBR-10: grant 모델) — owner/admin만."""
    await _require_owner_or_admin(project_id, auth, session)
    if body.permission != "granted":
        raise HTTPException(status_code=400, detail="permission must be 'granted'")
    if (body.member_id is None) == (body.org_member_id is None):
        raise HTTPException(
            status_code=422, detail="exactly one of org_member_id (human) or member_id (agent) required"
        )

    if body.member_id is not None:
        # 18073a52: 에이전트 grant — member_id(=agent members.id) 앵커, org_member_id 없음.
        # 대상이 프로젝트 org 의 활성 에이전트인지 검증(ensure_human_member skip).
        from sqlalchemy import text
        agent_ok = (await session.execute(
            text(
                "SELECT 1 FROM members m JOIN projects p ON p.id = :pid "
                "WHERE m.id = :mid AND m.type = 'agent' AND m.deleted_at IS NULL "
                "AND m.org_id = p.org_id LIMIT 1"
            ),
            {"pid": str(project_id), "mid": str(body.member_id)},
        )).scalar_one_or_none()
        if agent_ok is None:
            raise HTTPException(
                status_code=400, detail="member_id must be an active agent in the project's org"
            )
        existing = await session.execute(
            select(ProjectAccess).where(
                ProjectAccess.project_id == project_id,
                ProjectAccess.member_id == body.member_id,
            )
        )
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail="Access record already exists")
        record = ProjectAccess(
            project_id=project_id,
            org_member_id=None,
            member_id=body.member_id,
            permission=body.permission,
        )
    else:
        existing = await session.execute(
            select(ProjectAccess).where(
                ProjectAccess.project_id == project_id,
                ProjectAccess.org_member_id == body.org_member_id,
            )
        )
        if existing.scalar_one_or_none() is not None:
            raise HTTPException(status_code=409, detail="Access record already exists")
        # AC3-2c grant write-sync: canonical member_id(=org_member.id) 세팅 — AC3-4 projection의 member_id
        # 읽기 토대 + (A) resolver-cutover 통일. 휴먼 members 행을 선행 보장(fk_project_access_member NOT VALID이나
        # 신규 INSERT 검증). members 보장 실패(org_member 부재) 시 member_id 미세팅(레거시 호환).
        from app.services.agent_anchor_sync import ensure_human_member
        member_ok = await ensure_human_member(session, body.org_member_id)
        record = ProjectAccess(
            project_id=project_id,
            org_member_id=body.org_member_id,
            permission=body.permission,
            member_id=body.org_member_id if member_ok else None,
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
