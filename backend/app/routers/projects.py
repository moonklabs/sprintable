import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.project import ProjectRepository
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/api/v2/projects", tags=["projects"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> ProjectRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return ProjectRepository(session, uuid.UUID(str(org_id_str)))


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
    _auth: AuthContext = Depends(get_current_user),
) -> ProjectResponse:
    repo = ProjectRepository(session, body.org_id)
    project = await repo.create(name=body.name, description=body.description)
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
