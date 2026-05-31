"""E-CAGE-REFEREE P3: HITL Gate CRUD + 전이 엔드포인트."""
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.gate import Gate, is_valid_transition
from app.services.gate_service import create_gate, transition_gate

router = APIRouter(prefix="/api/v2/gates", tags=["gates"])


class GateCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    gate_type: str
    member_id: uuid.UUID
    role_id: uuid.UUID
    neutral_facts: dict[str, Any] | None = None


class GateTransitionRequest(BaseModel):
    status: str
    resolver_id: uuid.UUID | None = None


class GateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    work_item_id: uuid.UUID
    work_item_type: str
    gate_type: str
    status: str
    resolver_id: uuid.UUID | None = None
    resolved_at: datetime | None = None
    neutral_facts: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


@router.post("", response_model=GateResponse, status_code=201)
async def create_gate_endpoint(
    body: GateCreateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> GateResponse:
    gate = await create_gate(
        session=session,
        org_id=org_id,
        work_item_id=body.work_item_id,
        work_item_type=body.work_item_type,
        gate_type=body.gate_type,
        member_id=body.member_id,
        role_id=body.role_id,
        neutral_facts=body.neutral_facts,
    )
    await session.commit()
    return GateResponse.model_validate(gate)


@router.get("", response_model=list[GateResponse])
async def list_gates(
    work_item_id: uuid.UUID | None = Query(default=None),
    work_item_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[GateResponse]:
    q = select(Gate).where(Gate.org_id == org_id)
    if work_item_id:
        q = q.where(Gate.work_item_id == work_item_id)
    if work_item_type:
        q = q.where(Gate.work_item_type == work_item_type)
    if status:
        q = q.where(Gate.status == status)
    result = await session.execute(q)
    return [GateResponse.model_validate(g) for g in result.scalars().all()]


@router.post("/{id}/transition", response_model=GateResponse)
async def transition_gate_endpoint(
    id: uuid.UUID,
    body: GateTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> GateResponse:
    try:
        gate = await transition_gate(session, org_id, id, body.status, body.resolver_id)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
