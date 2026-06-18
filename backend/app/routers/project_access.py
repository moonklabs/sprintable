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
    # E-MEMBER-POLICY S3: per-project 역할(owner/admin/member) 노출 — FE 가 owner 지정 UI 에 사용.
    role: str = "member"
    created_at: datetime


def _get_org_repo(session: AsyncSession = Depends(get_db)) -> OrganizationRepository:
    return OrganizationRepository(session)


async def _require_owner_or_admin(
    project_id: uuid.UUID, auth: AuthContext, session: AsyncSession
) -> None:
    """프로젝트 관리 권한(owner/admin) 확인.

    E-MEMBER-POLICY S2: org_members.role 만 보던 것을 **effective 프로젝트 역할**로 전환(소비 시작).
    has_project_role(min_role='admin') = project_access.role(owner/admin) OR org owner/admin floor →
    기존(org owner/admin 통과)은 floor 로 보존(무회귀), project owner/admin 추가 통과(additive).
    """
    from sqlalchemy import text
    result = await session.execute(
        text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"),
        {"pid": str(project_id)},
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    from app.services.project_auth import has_project_role
    if not await has_project_role(
        session, uuid.UUID(auth.user_id), project_id, min_role="admin"
    ):
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
        # S4 (org-level 멀티프로젝트): grant 확장 시 per-project 런타임(agent_project_profiles)도
        # 멱등 생성 — 안 하면 뷰 branch3(런타임 NULL)로만 떠 presence/런타임 write 가 0행 무음 누락.
        from app.services.agent_anchor_sync import ensure_agent_project_profile
        await ensure_agent_project_profile(
            session, member_id=body.member_id, project_id=project_id
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

    # S4: 에이전트 grant 회수 시 per-project 런타임 행(agent_project_profiles)도 제거 — 안 하면
    # team_members 뷰 branch2(profile join)가 회수된 에이전트를 계속 노출(grant↔뷰 불일치·한쪽만
    # 전환 트랩). 에이전트 grant = org_member_id NULL + member_id set. 휴먼이면 매칭 profile 0행이라
    # 무해하지만 guard 로 의도 명시.
    if record.org_member_id is None and record.member_id is not None:
        from sqlalchemy import delete as sa_delete

        from app.models.member import AgentProjectProfile
        await session.execute(
            sa_delete(AgentProjectProfile.__table__).where(
                AgentProjectProfile.__table__.c.member_id == record.member_id,
                AgentProjectProfile.__table__.c.project_id == project_id,
            )
        )

    await session.delete(record)
    await session.commit()
    return {"ok": True}


class SetProjectRoleRequest(BaseModel):
    role: str  # 'owner' | 'admin' | 'member'


@router.put("/{project_id}/access/{member_id}/role", response_model=ProjectAccessResponse)
async def set_project_role(
    project_id: uuid.UUID,
    member_id: uuid.UUID,
    body: SetProjectRoleRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ProjectAccessResponse:
    """멤버의 per-project 역할(owner/admin/member) 지정 — E-MEMBER-POLICY S3 / AC#1(owner 지정).

    권한(§9-3): **project owner** 또는 **org owner/admin**(project admin 은 역할 지정 불가).
    대상은 해당 프로젝트에 project_access 행이 있는 멤버(휴먼=member_id 또는 org_member_id 매칭,
    에이전트=member_id). 행 없으면 404. role 은 enum 검증(비-enum 400) — 0122 CHECK 정합.
    """
    from sqlalchemy import text
    from sqlalchemy import update as sa_update

    from app.services.project_auth import (
        PROJECT_ROLES,
        get_project_role,
        is_org_owner_or_admin,
    )

    if body.role not in PROJECT_ROLES:
        raise HTTPException(
            status_code=400, detail=f"role must be one of {list(PROJECT_ROLES)}"
        )

    # 프로젝트 → org 역추적(존재 404)
    org_row = (
        await session.execute(
            text("SELECT org_id FROM projects WHERE id = :pid AND deleted_at IS NULL"),
            {"pid": str(project_id)},
        )
    ).first()
    if org_row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    org_id = org_row[0]

    # 권한(§9-3): project owner OR org owner/admin. project admin 은 불가(get_project_role!=owner
    # AND not org owner/admin). org owner 는 effective owner(floor)라 첫 조건으로 통과.
    actor = uuid.UUID(auth.user_id)
    is_proj_owner = (await get_project_role(session, actor, project_id)) == "owner"
    if not (is_proj_owner or await is_org_owner_or_admin(session, actor, org_id)):
        raise HTTPException(
            status_code=403, detail="project owner or org owner/admin required"
        )

    # 대상 project_access 행 role 갱신 — 휴먼(member_id|org_member_id)·에이전트(member_id) 모두 매칭.
    result = await session.execute(
        sa_update(ProjectAccess)
        .where(
            ProjectAccess.project_id == project_id,
            (ProjectAccess.member_id == member_id)
            | (ProjectAccess.org_member_id == member_id),
        )
        .values(role=body.role)
    )
    if result.rowcount == 0:
        raise HTTPException(
            status_code=404, detail="Member has no access record in this project"
        )
    await session.commit()

    record = (
        await session.execute(
            select(ProjectAccess).where(
                ProjectAccess.project_id == project_id,
                (ProjectAccess.member_id == member_id)
                | (ProjectAccess.org_member_id == member_id),
            )
        )
    ).scalars().first()
    return ProjectAccessResponse.model_validate(record)
