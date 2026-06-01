import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.epic import EpicRepository
from app.schemas.epic import EpicCreate, EpicProgressResponse, EpicResponse, EpicUpdate

router = APIRouter(prefix="/api/v2/epics", tags=["epics"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EpicRepository:
    return EpicRepository(session, org_id)


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


def _resolve_outcome_status(metric_definition: object, measure_after: object, current_status: str = "n_a") -> str:
    """intent가 완전히 선언(md+ma 둘 다 세팅)되면 n_a→pending 전이."""
    if metric_definition and measure_after and current_status == "n_a":
        return "pending"
    return current_status


@router.post("", response_model=EpicResponse, status_code=201)
async def create_epic(
    body: EpicCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EpicResponse:
    enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
    )
    repo = EpicRepository(session, org_id)
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
        success_hypothesis=body.success_hypothesis,
        metric_definition=body.metric_definition,
        measure_after=body.measure_after,
        outcome_status=_resolve_outcome_status(body.metric_definition, body.measure_after),
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
    current = await repo.get(id)
    if current is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    data = body.model_dump(exclude_unset=True)
    # intent가 이번 업데이트로 완성되면 n_a→pending 전이
    effective_md = data.get("metric_definition", current.metric_definition)
    effective_ma = data.get("measure_after", current.measure_after)
    new_status = _resolve_outcome_status(effective_md, effective_ma, current.outcome_status)
    if new_status != current.outcome_status:
        data["outcome_status"] = new_status
    epic = await repo.update(id, **data)
    if epic is None:
        raise HTTPException(status_code=404, detail="Epic not found")
    return EpicResponse.model_validate(epic)


@router.delete("/{id}", status_code=200)
async def delete_epic(
    id: uuid.UUID,
    repo: EpicRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    from app.repositories.dependency import DependencyRepository
    from app.repositories.label import ItemLabelRepository
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Epic not found")
    await DependencyRepository(session, org_id).delete_by_item(id, "epic")
    await ItemLabelRepository(session, org_id).delete_by_item(id, "epic")
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
