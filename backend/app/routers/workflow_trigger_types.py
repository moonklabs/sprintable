import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, require_admin
from app.dependencies.database import get_db
from app.repositories.workflow_trigger_type import WorkflowTriggerTypeRepository

router = APIRouter(prefix="/api/v2/workflow-trigger-types", tags=["workflow-trigger-types"])


class TriggerTypeResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    slug: str
    label: str
    description: str | None = None
    is_system: bool
    is_enabled: bool

    model_config = {"from_attributes": True}


class TriggerTypeCreate(BaseModel):
    slug: str
    label: str
    description: str | None = None


class TriggerTypeUpdate(BaseModel):
    label: str | None = None
    description: str | None = None
    is_enabled: bool | None = None


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> WorkflowTriggerTypeRepository:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return WorkflowTriggerTypeRepository(session, uuid.UUID(str(org_id_str)))


@router.get("", response_model=list[TriggerTypeResponse])
async def list_trigger_types(
    repo: WorkflowTriggerTypeRepository = Depends(_get_repo),
) -> list[TriggerTypeResponse]:
    items = await repo.list()
    return [TriggerTypeResponse.model_validate(i) for i in items]


@router.post("", response_model=TriggerTypeResponse, status_code=201)
async def create_trigger_type(
    body: TriggerTypeCreate,
    repo: WorkflowTriggerTypeRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> TriggerTypeResponse:
    obj = await repo.create(slug=body.slug, label=body.label, description=body.description)
    return TriggerTypeResponse.model_validate(obj)


@router.patch("/{id}", response_model=TriggerTypeResponse)
async def update_trigger_type(
    id: uuid.UUID,
    body: TriggerTypeUpdate,
    repo: WorkflowTriggerTypeRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> TriggerTypeResponse:
    obj = await repo.get(id)
    if obj is None:
        raise HTTPException(status_code=404, detail="Trigger type not found")
    if obj.is_system:
        data = body.model_dump(exclude_unset=True)
        allowed = {"is_enabled"}
        forbidden = set(data.keys()) - allowed
        if forbidden:
            raise HTTPException(status_code=403, detail="System trigger types cannot be modified (only is_enabled allowed)")
    data = body.model_dump(exclude_unset=True)
    updated = await repo.update(id, **data)
    return TriggerTypeResponse.model_validate(updated)


@router.delete("/{id}", status_code=200)
async def delete_trigger_type(
    id: uuid.UUID,
    repo: WorkflowTriggerTypeRepository = Depends(_get_repo),
    _: None = Depends(require_admin),
) -> dict:
    obj = await repo.get(id)
    if obj is None:
        raise HTTPException(status_code=404, detail="Trigger type not found")
    if obj.is_system:
        raise HTTPException(status_code=403, detail="System trigger types cannot be deleted")
    await repo.delete(id)
    return {"ok": True}
