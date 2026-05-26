import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.project import ProjectRepository
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/api/v2/projects", tags=["projects"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ProjectRepository:
    return ProjectRepository(session, org_id)


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    repo: ProjectRepository = Depends(_get_repo),
) -> list[ProjectResponse]:
    projects = await repo.list()
    return [ProjectResponse.model_validate(p) for p in projects]


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
    # Ensure the creating user is in org_members and team_members.
    if auth.user_id:
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role)"
                " VALUES (gen_random_uuid(), :org_id, :user_id, 'member')"
                " ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org_id": str(org_id), "user_id": auth.user_id},
        )
        # Auto-create team_members row so SSE and project-scoped auth work immediately.
        member_name = (auth.email or auth.user_id).split("@")[0]
        await session.execute(
            text(
                "INSERT INTO team_members"
                " (id, org_id, project_id, user_id, type, name, role, is_active, color, can_manage_members)"
                " VALUES (gen_random_uuid(), :org_id, :project_id, :user_id,"
                "         'human', :name, 'owner', true, '#3385f8', true)"
            ),
            {
                "org_id": str(org_id),
                "project_id": str(project.id),
                "user_id": auth.user_id,
                "name": member_name,
            },
        )

    await session.commit()

    return ProjectResponse.model_validate(project)


@router.get("/{id}", response_model=ProjectResponse)
async def get_project(
    id: uuid.UUID,
    repo: ProjectRepository = Depends(_get_repo),
) -> ProjectResponse:
    project = await repo.get(id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse.model_validate(project)


@router.patch("/{id}", response_model=ProjectResponse)
async def update_project(
    id: uuid.UUID,
    body: ProjectUpdate,
    repo: ProjectRepository = Depends(_get_repo),
) -> ProjectResponse:
    data = body.model_dump(exclude_unset=True)
    project = await repo.update(id, **data)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse.model_validate(project)


@router.delete("/{id}", status_code=200)
async def delete_project(
    id: uuid.UUID,
    repo: ProjectRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}
