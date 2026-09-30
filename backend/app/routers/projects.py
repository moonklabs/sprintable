import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.project import Project
from app.repositories.project import ProjectRepository
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from app.services.org_project_create import check_project_create_allowed, create_project_with_member
from app.services.entity_slug import (
    is_project_slug_taken,
    is_valid_slug_format,
)
from app.services.project_auth import (
    accessible_project_ids_in_org,
    has_project_access,
    is_org_owner_or_admin,
)

router = APIRouter(prefix="/api/v2/projects", tags=["projects", "Organization"])


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    # story #2451(§6 Phase3 A1): org roster·create→self-read 흐름 없음 → read replica.
    session: AsyncSession = Depends(get_read_db),
) -> list[ProjectResponse]:
    """정책B: 접근 가능한 프로젝트만 반환 — team_member ∪ project_access(granted) ∪ owner/admin org-wide.
    접근권 없는 멤버는 빈 목록(이전엔 org 전체 노출). owner/admin은 org 전체."""
    ids = await accessible_project_ids_in_org(session, uuid.UUID(auth.user_id), org_id)
    if not ids:
        return []
    rows = await session.execute(
        select(Project)
        .where(Project.id.in_(ids), Project.deleted_at.is_(None))
        .order_by(Project.created_at.asc(), Project.id)
    )
    return [ProjectResponse.model_validate(p) for p in rows.scalars().all()]


@router.post("", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: ProjectCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ProjectResponse:
    # story 4427 (나) piece 1 — the limit and the writes live in services/org_project_create.py (no commit there) so the
    # desktop setup can make a project inside its own transaction; this route commits as before.
    await check_project_create_allowed(session, org_id)
    project = await create_project_with_member(
        session, org_id=org_id, name=body.name, description=body.description, slug=body.slug, user_id=auth.user_id,
    )

    await session.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
    await session.refresh(project)

    return ProjectResponse.model_validate(project)


@router.get("/resolve", response_model=ProjectResponse)
async def resolve_project_by_slug(
    slug: str,
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    """story 139d2405(S-slug-infra): project slug(workspace 내 유일) → project 해소(S-route-project
    FE middleware가 소비 예정). org_id는 호출자 workspace 컨텍스트(get_verified_org_id)로 자동 스코프.
    ⚠️`/{id}` 라우트보다 먼저 등록해야 "resolve"가 UUID 파싱으로 새지 않는다."""
    row = await session.execute(
        select(Project).where(
            Project.org_id == org_id, Project.slug == slug, Project.deleted_at.is_(None),
        )
    )
    project = row.scalar_one_or_none()
    if project is None or not await has_project_access(session, uuid.UUID(auth.user_id), project.id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")
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
    existing = await repo.get(id)
    if existing is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), id, org_id
    ):
        raise HTTPException(status_code=404, detail="Project not found")
    data = body.model_dump(exclude_unset=True)

    # story 139d2405(S-slug-infra): slug rename — 형식/org 내 유일성(자기 제외, 충돌 시 409 —
    # organizations rename과 동형) 검증 + 이력 기록(향후 S-route-project의 301 해소용).
    # old==new(무변경 재전송)면 이력 skip.
    if "slug" in data and data["slug"] is not None and data["slug"] != existing.slug:
        if not is_valid_slug_format(data["slug"]):
            raise HTTPException(status_code=400, detail="Invalid slug format")
        if await is_project_slug_taken(session, org_id, data["slug"], exclude_project_id=id):
            raise HTTPException(status_code=409, detail="Slug already exists")
        from app.models.entity_slug_history import EntitySlugHistory
        session.add(EntitySlugHistory(
            org_id=org_id, entity_type="project", entity_id=id,
            old_slug=existing.slug, new_slug=data["slug"],
        ))
    elif "slug" in data and data["slug"] == existing.slug:
        data.pop("slug")

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
    from app.models.deletion_audit import DeletionAuditLog
    from app.services.member_resolver import resolve_member

    repo = ProjectRepository(session, org_id)
    project = await repo.get(id)
    # 미접근 멤버에겐 존재 비노출(404).
    if project is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), id, org_id
    ):
        raise HTTPException(status_code=404, detail="Project not found")
    # 삭제는 파괴적(stories/tasks cascade) — 접근권만으론 불가, org owner/admin 전용.
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(
            status_code=403,
            detail="프로젝트 삭제는 조직 owner/admin 권한이 필요합니다",
        )
    # E-SECURITY SEC-S1 확장(까심 적대적 QA 발견): is_org_owner_or_admin은 org_members(휴먼 전용)만
    # 조회해 에이전트가 구조적으로 통과 불가하나 암묵적 부산물일 뿐 — story·epic과 동형으로 명시적
    # human-only 체크 + 삭제 감사를 추가한다(cascade 파괴력 고려).
    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Project 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")
    session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=org_id, actor_id=resolved.id,
        entity_type="project", entity_id=id, entity_title=project.name,
    ))
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}
