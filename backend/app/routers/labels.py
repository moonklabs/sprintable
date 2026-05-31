import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.label import ITEM_TYPES
from app.repositories.label import ItemLabelRepository, LabelRepository
from app.schemas.label import ItemLabelCreate, ItemLabelResponse, LabelCreate, LabelResponse, LabelUpdate

router = APIRouter(prefix="/api/v2/labels", tags=["labels"])
item_label_router = APIRouter(prefix="/api/v2/item-labels", tags=["labels"])


def _get_label_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LabelRepository:
    return LabelRepository(session, org_id)


def _get_item_label_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ItemLabelRepository:
    return ItemLabelRepository(session, org_id)


# ── Label CRUD ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[LabelResponse])
async def list_labels(
    repo: LabelRepository = Depends(_get_label_repo),
    _auth=Depends(get_current_user),
) -> list[LabelResponse]:
    labels = await repo.list()
    return [LabelResponse.model_validate(l) for l in labels]


@router.post("", response_model=LabelResponse, status_code=201)
async def create_label(
    body: LabelCreate,
    repo: LabelRepository = Depends(_get_label_repo),
    _auth=Depends(get_current_user),
) -> LabelResponse:
    label = await repo.create(name=body.name, color=body.color)
    return LabelResponse.model_validate(label)


@router.get("/{id}", response_model=LabelResponse)
async def get_label(
    id: uuid.UUID,
    repo: LabelRepository = Depends(_get_label_repo),
    _auth=Depends(get_current_user),
) -> LabelResponse:
    label = await repo.get(id)
    if label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    return LabelResponse.model_validate(label)


@router.patch("/{id}", response_model=LabelResponse)
async def update_label(
    id: uuid.UUID,
    body: LabelUpdate,
    repo: LabelRepository = Depends(_get_label_repo),
    _auth=Depends(get_current_user),
) -> LabelResponse:
    data = body.model_dump(exclude_unset=True)
    label = await repo.update(id, **data)
    if label is None:
        raise HTTPException(status_code=404, detail="Label not found")
    return LabelResponse.model_validate(label)


@router.delete("/{id}", status_code=200)
async def delete_label(
    id: uuid.UUID,
    repo: LabelRepository = Depends(_get_label_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Label not found")
    await ItemLabelRepository(session, org_id).delete_by_label(id)
    return {"ok": True}


# ── ItemLabel attach/detach/list ───────────────────────────────────────────────

@item_label_router.post("", response_model=ItemLabelResponse, status_code=201)
async def attach_label(
    body: ItemLabelCreate,
    repo: ItemLabelRepository = Depends(_get_item_label_repo),
    _auth=Depends(get_current_user),
) -> ItemLabelResponse:
    if await repo.exists(body.label_id, body.item_id, body.item_type):
        raise HTTPException(status_code=409, detail="이미 부착된 라벨")
    il = await repo.create(
        label_id=body.label_id,
        item_id=body.item_id,
        item_type=body.item_type,
    )
    return ItemLabelResponse.model_validate(il)


@item_label_router.get("", response_model=list[ItemLabelResponse])
async def list_item_labels(
    item_type: str = Query(...),
    item_id: uuid.UUID = Query(...),
    repo: ItemLabelRepository = Depends(_get_item_label_repo),
    _auth=Depends(get_current_user),
) -> list[ItemLabelResponse]:
    if item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    items = await repo.list_by_item(item_id, item_type)
    return [ItemLabelResponse.model_validate(i) for i in items]


@item_label_router.delete("/{id}", status_code=200)
async def detach_label(
    id: uuid.UUID,
    repo: ItemLabelRepository = Depends(_get_item_label_repo),
    _auth=Depends(get_current_user),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Item label not found")
    return {"ok": True}
