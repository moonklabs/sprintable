import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.epic import EpicRepository
from app.schemas.epic import EpicCreate, EpicProgressResponse, EpicResponse, EpicUpdate

router = APIRouter(prefix="/api/v2/epics", tags=["epics"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> EpicRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="org_id required (X-Org-Id header or JWT app_metadata)",
        )
    return EpicRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[EpicResponse])
async def list_epics(
    project_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    repo: EpicRepository = Depends(_get_repo),
) -> list[EpicResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if status_filter:
        filters["status"] = status_filter
    epics = await repo.list(**filters)
    return [EpicResponse.model_validate(e) for e in epics]


@router.post("", response_model=EpicResponse, status_code=201)
async def create_epic(
    body: EpicCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> EpicResponse:
    repo = EpicRepository(session, body.org_id)
    epic = await repo.create(
        project_id=body.project_id,
        title=body.title,
        status=body.status,
        priority=body.priority,
        description=body.description,
        objective=body.objective,
        success_criteria=body.success_criteria,
        target_sp=body.target_sp,
        target_date=body.target_date,
    )
    return EpicResponse.model_validate(epic)


@router.get("/{id}", response_model=EpicResponse)
async def get_epic(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicResponse:
    epic = await repo.get(id)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return EpicResponse.model_validate(epic)


@router.patch("/{id}", response_model=EpicResponse)
async def update_epic(
    id: uuid.UUID,
    body: EpicUpdate,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicResponse:
    data = body.model_dump(exclude_unset=True)
    epic = await repo.update(id, **data)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return EpicResponse.model_validate(epic)


@router.delete("/{id}", status_code=200)
async def delete_epic(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Epic not found")
    return {"ok": True}


@router.get("/{id}/progress", response_model=EpicProgressResponse)
async def get_epic_progress(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
) -> EpicProgressResponse:
    epic = await repo.get(id)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return await repo.get_progress(id)
