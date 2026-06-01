import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.dependency import ITEM_TYPES
from app.repositories.dependency import DependencyRepository
from app.schemas.dependency import DependencyCreate, DependencyGraphResponse, DependencyResponse
from app.services.dependency_graph import get_graph, would_create_cycle

router = APIRouter(prefix="/api/v2/dependencies", tags=["dependencies"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DependencyRepository:
    return DependencyRepository(session, org_id)


@router.post("", response_model=DependencyResponse, status_code=201)
async def create_dependency(
    body: DependencyCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> DependencyResponse:
    if body.from_id == body.to_id:
        raise HTTPException(status_code=422, detail="자기참조 의존성은 허용되지 않음")

    repo = DependencyRepository(session, org_id)

    if await repo.exists(body.from_id, body.to_id, body.item_type):
        raise HTTPException(status_code=409, detail="이미 존재하는 의존성")

    if await would_create_cycle(session, org_id, body.from_id, body.to_id, body.item_type):
        raise HTTPException(status_code=422, detail="사이클이 발생하는 의존성은 허용되지 않음")

    dep = await repo.create(
        from_id=body.from_id,
        to_id=body.to_id,
        dep_type=body.dep_type,
        item_type=body.item_type,
    )
    return DependencyResponse.model_validate(dep)


@router.get("", response_model=list[DependencyResponse])
async def list_dependencies(
    item_type: str = Query(...),
    item_id: uuid.UUID = Query(...),
    repo: DependencyRepository = Depends(_get_repo),
) -> list[DependencyResponse]:
    if item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    deps = await repo.list_by_item(item_id, item_type)
    return [DependencyResponse.model_validate(d) for d in deps]


@router.delete("/{id}", status_code=200)
async def delete_dependency(
    id: uuid.UUID,
    repo: DependencyRepository = Depends(_get_repo),
    _auth=Depends(get_current_user),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")
    return {"ok": True}


@router.get("/graph", response_model=DependencyGraphResponse)
async def dependency_graph(
    item_type: str = Query(...),
    item_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> DependencyGraphResponse:
    if item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    item_ids = [item_id] if item_id else None
    nodes, edges = await get_graph(session, org_id, item_type, item_ids)
    return DependencyGraphResponse(item_type=item_type, nodes=nodes, edges=edges)
