import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.repositories.project import ProjectRepository
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.services.agent_anchor_sync import ensure_human_member
from app.services.project_auth import (
    accessible_project_ids_in_org,
    has_project_access,
    is_org_owner_or_admin,
)

router = APIRouter(prefix="/api/v2/projects", tags=["projects"])


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> list[ProjectResponse]:
    """정책B: 접근 가능한 프로젝트만 반환 — team_member ∪ project_access(granted) ∪ owner/admin org-wide.
    접근권 없는 멤버는 빈 목록(이전엔 org 전체 노출). owner/admin은 org 전체."""
    ids = await accessible_project_ids_in_org(session, uuid.UUID(auth.user_id), org_id)
    if not ids:
        return []
    rows = await session.execute(
        select(Project)
        .where(Project.id.in_(ids), Project.deleted_at.is_(None))
        .order_by(Project.created_at.asc())
    )
    return [ProjectResponse.model_validate(p) for p in rows.scalars().all()]


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: ProjectCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ProjectResponse:
    repo = ProjectRepository(session, org_id)

    # EE: Free 플랜 project 생성 제한 (OSS에서는 로드되지 않음)
    if settings.is_ee_enabled:
        from ee.plan_limits import check_project_create_limit  # type: ignore[import]
        await check_project_create_limit(session, org_id)

    project = await repo.create(name=body.name, description=body.description)

    # project_memberships 테이블 미존재 — agent 자동 첨부는 agent 생성 시 project_id로 직접 연결.
    # Ensure the creating user is in org_members (S5: human type team_member 신규 생성 제거).
    if auth.user_id:
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role)"
                " VALUES (gen_random_uuid(), :org_id, :user_id, 'member')"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org_id), "user_id": auth.user_id},
        )
        # 생성자 휴먼 members 앵커 보장(#1317 휴먼판): org_member.id를 (신규/기존 무관) 재조회 후
        # ensure_human_member 호출. ON CONFLICT DO NOTHING이라 RETURNING 불가 → SELECT로 캡처.
        om_id = (
            await session.execute(
                text(
                    "SELECT id FROM org_members"
                    " WHERE org_id = :org_id AND user_id = :user_id"
                    " AND deleted_at IS NULL LIMIT 1"
                ),
                {"org_id": str(org_id), "user_id": auth.user_id},
            )
        ).scalar_one_or_none()
        if om_id is not None:
            await ensure_human_member(session, om_id)

    await session.commit()

    return ProjectResponse.model_validate(project)


@router.get("/{id}", response_model=ProjectResponse)
async def get_project(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    # 정책B 정합: 미부여 일반 org-member 는 프로젝트 존재/메타 비노출(list_projects 가시성과 일치).
    # grant ∪ owner/admin 만 열람 허용. 미접근은 404 로 존재 자체를 숨겨 정보노출 제거.
    project = await ProjectRepository(session, org_id).get(id)
    if project is None or not await has_project_access(session, uuid.UUID(auth.user_id), id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse.model_validate(project)


@router.patch("/{id}", response_model=ProjectResponse)
async def update_project(
    id: uuid.UUID,
    body: ProjectUpdate,
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    repo = ProjectRepository(session, org_id)
    # 편집은 부여 멤버 ∪ owner/admin 만. 미접근은 404(비노출).
    if await repo.get(id) is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), id, org_id
    ):
        raise HTTPException(status_code=404, detail="Project not found")
    data = body.model_dump(exclude_unset=True)
    project = await repo.update(id, **data)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse.model_validate(project)


@router.delete("/{id}", status_code=200)
async def delete_project(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> dict:
    repo = ProjectRepository(session, org_id)
    # 미접근 멤버에겐 존재 비노출(404).
    if await repo.get(id) is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), id, org_id
    ):
        raise HTTPException(status_code=404, detail="Project not found")
    # 삭제는 파괴적(stories/tasks cascade) — 접근권만으론 불가, org owner/admin 전용.
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(
            status_code=403,
            detail="프로젝트 삭제는 조직 owner/admin 권한이 필요합니다",
        )
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}
