"""E-CAGE-REFEREE P3: HITL Gate CRUD + 전이 엔드포인트."""
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.gate import Gate
from app.services.gate_service import (
    create_gate,
    hold_gate,
    transition_gate,
    unhold_gate,
    void_gate,
)
from app.services.member_resolver import resolve_member
from app.services.project_auth import is_org_owner_or_admin

# 사람 검증 행위(approve/reject) — "human-validated" 웨지 integrity상 휴먼 member만 허용.
_HUMAN_REVIEW_STATUSES = frozenset({"approved", "rejected"})

router = APIRouter(prefix="/api/v2/gates", tags=["gates"])


class GateCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    gate_type: str
    member_id: uuid.UUID
    role_id: uuid.UUID
    neutral_facts: dict[str, Any] | None = None

    @field_validator("gate_type")
    @classmethod
    def validate_gate_type(cls, v: str) -> str:
        from app.models.hitl_config import GATE_TYPES
        if v not in GATE_TYPES:
            raise ValueError(f"gate_type must be one of {sorted(GATE_TYPES)}")
        return v


class GateTransitionRequest(BaseModel):
    status: str
    resolver_id: uuid.UUID | None = None
    note: str | None = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        from app.models.gate import GATE_STATUSES
        if v not in GATE_STATUSES:
            raise ValueError(f"status must be one of {sorted(GATE_STATUSES)}")
        return v


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
    resolution_note: str | None = None
    held_until: datetime | None = None  # S31: status='held' 시 시한부 만료(무기한이면 None)·additive
    neutral_facts: dict[str, Any] | None = None
    # H1-S3: merge verdict gate evidence metadata (0118)·additive·하위호환 default.
    requires_human: bool = False
    evidence_status: str | None = None
    decision_basis: str | None = None
    auto_decision_reason: str | None = None
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
    auth=Depends(get_current_user),
) -> GateResponse:
    # authz(93fc7aeb): 게이트 approve/reject는 **휴먼 member만**. 에이전트(API key)가 사람 검증
    # 게이트를 승인하면 "agent-assisted·human-validated" 웨지 전제가 무너지므로 차단(403).
    # 시스템 auto-resolution(resolve_gate_from_verdict)은 transition_gate 서비스 직호출이라 무영향.
    _resolver_id = body.resolver_id
    if body.status in _HUMAN_REVIEW_STATUSES:
        resolved = await resolve_member(auth, org_id, session)
        if resolved.type != "human":
            raise HTTPException(
                status_code=403,
                detail="게이트 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 승인 불가).",
            )
        # ⭐S23 RC①(SoD 위조 봉): resolver_id 를 인증 caller 로 강제 — body 조작(타인 UUID)으로
        # SoD(approver≠owner) 우회·confirmed_by_member_id 위조하는 경로 차단(전 gate 타입 공통).
        _resolver_id = resolved.id
    try:
        gate = await transition_gate(session, org_id, id, body.status, _resolver_id, body.note)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateVoidRequest(BaseModel):
    reason: str  # 사유 필수(audit·파괴적 액션). 빈 사유는 서비스서 422.


@router.post("/{id}/void", response_model=GateResponse)
async def void_gate_endpoint(
    id: uuid.UUID,
    body: GateVoidRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S30 admin recovery: 잘못 생성된 pending gate 무효화(void). admin-only(project_auth canonical).

    voider 는 **인증 caller 강제**(body 신뢰 0·S23 RC① 패턴). void≠approval — 묶인 step_run 해소로
    엔티티 unblock(re-route 가능)되되 전이 미적용. transition 단일경로(void 는 void_gate SSOT)."""
    resolved = await resolve_member(auth, org_id, session)
    # Q4: canonical project_auth admin 게이팅(ad-hoc role 금지·S27/S29 교훈). org owner/admin 만.
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="게이트 무효화는 org owner/admin 만 가능합니다.")
    try:
        gate = await void_gate(session, org_id, id, resolved.id, body.reason)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateHoldRequest(BaseModel):
    reason: str | None = None       # S31: 보류 사유(선택·가역적 일시정지라 마찰↓)
    held_until: datetime | None = None  # 시한부 만료(무기한이면 None)


async def _require_gate_admin(session, auth, org_id):
    """⭐S31/S30 공통: gate 파괴적/관리 액션 admin 게이팅(canonical project_auth·ad-hoc role 금지).
    반환 resolved member(holder/voider=인증 caller 강제용·body 신뢰 0)."""
    resolved = await resolve_member(auth, org_id, session)
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="이 액션은 org owner/admin 만 가능합니다.")
    return resolved


@router.post("/{id}/hold", response_model=GateResponse)
async def hold_gate_endpoint(
    id: uuid.UUID,
    body: GateHoldRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S31 admin hold: pending gate 일시 보류(held·SLA pause). admin-only·holder=인증 caller 강제."""
    resolved = await _require_gate_admin(session, auth, org_id)
    try:
        gate = await hold_gate(session, org_id, id, resolved.id, body.reason, body.held_until)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{id}/unhold", response_model=GateResponse)
async def unhold_gate_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S31 admin unhold: held gate 재개(→pending·SLA resume). admin-only·actor=인증 caller."""
    resolved = await _require_gate_admin(session, auth, org_id)
    try:
        gate = await unhold_gate(session, org_id, id, resolved.id)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
