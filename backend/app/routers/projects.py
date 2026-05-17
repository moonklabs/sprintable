import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

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
) -> ProjectResponse:
    repo = ProjectRepository(session, body.org_id)
    project = await repo.create(name=body.name, description=body.description)

    # Auto-attach org-level team members (project_id IS NULL) to new project
    await session.execute(
        text(
            "INSERT INTO project_memberships (project_id, team_member_id)"
            " SELECT :project_id, id FROM team_members"
            " WHERE org_id = :org_id AND project_id IS NULL AND is_active = TRUE"
            " ON CONFLICT DO NOTHING"
        ),
        {"org_id": str(body.org_id), "project_id": str(project.id)},
    )

    # OSS bootstrap: 프로젝트 생성 시 인증 유저 team_member 자동 생성
    # (Supabase trg_org_bootstrap_owner 대체 — project_id가 확정된 이 시점에 생성)
    if auth.user_id:
        await session.execute(
            text(
                "INSERT INTO team_members"
                " (id, org_id, project_id, user_id, name, type, role, is_active, color)"
                " SELECT gen_random_uuid(), :org_id, :project_id, :user_id,"
                "        COALESCE(u.email, 'owner'), 'human', 'member', true, '#4F46E5'"
                " FROM users u WHERE u.id = :user_id"
                " ON CONFLICT DO NOTHING"
            ),
            {"org_id": str(body.org_id), "project_id": str(project.id), "user_id": auth.user_id},
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
