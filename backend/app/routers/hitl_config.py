"""E-CAGE-REFEREE P3: HITL gate config CRUD + disposition 해소 엔드포인트."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.hitl_config import MemberGateOverride, OrgGateOverride, OrgGatePolicy
from app.repositories.base import BaseRepository
from app.schemas.hitl_config import (
    MemberGateOverrideCreate,
    MemberGateOverrideResponse,
    OrgGateOverrideCreate,
    OrgGateOverrideResponse,
    OrgGatePolicyCreate,
    OrgGatePolicyResponse,
    ResolveRequest,
    ResolveResponse,
)
from app.services.gate_resolver import resolve_disposition

router = APIRouter(prefix="/api/v2/gate-config", tags=["gate-config"])


# ── org posture ───────────────────────────────────────────────────────────────

@router.get("/policy", response_model=OrgGatePolicyResponse | None)
async def get_org_policy(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> OrgGatePolicyResponse | None:
    r = await session.execute(
        select(OrgGatePolicy).where(OrgGatePolicy.org_id == org_id).limit(1)
    )
    policy = r.scalar_one_or_none()
    if policy is None:
        return None
    return OrgGatePolicyResponse.model_validate(policy)


@router.put("/policy", response_model=OrgGatePolicyResponse)
async def upsert_org_policy(
    body: OrgGatePolicyCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> OrgGatePolicyResponse:
    r = await session.execute(
        select(OrgGatePolicy).where(OrgGatePolicy.org_id == org_id).limit(1)
    )
    policy = r.scalar_one_or_none()
    if policy is None:
        policy = OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, posture=body.posture)
        session.add(policy)
    else:
        policy.posture = body.posture
    await session.flush()
    await session.refresh(policy)
    return OrgGatePolicyResponse.model_validate(policy)


# ── org role overrides ─────────────────────────────────────────────────────────

@router.get("/overrides/org", response_model=list[OrgGateOverrideResponse])
async def list_org_overrides(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[OrgGateOverrideResponse]:
    r = await session.execute(
        select(OrgGateOverride).where(OrgGateOverride.org_id == org_id)
    )
    return [OrgGateOverrideResponse.model_validate(o) for o in r.scalars().all()]


@router.post("/overrides/org", response_model=OrgGateOverrideResponse, status_code=201)
async def upsert_org_override(
    body: OrgGateOverrideCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> OrgGateOverrideResponse:
    r = await session.execute(
        select(OrgGateOverride).where(
            OrgGateOverride.org_id == org_id,
            OrgGateOverride.role_id == body.role_id,
            OrgGateOverride.gate_type == body.gate_type,
        ).limit(1)
    )
    ov = r.scalar_one_or_none()
    if ov is None:
        ov = OrgGateOverride(
            id=uuid.uuid4(), org_id=org_id,
            role_id=body.role_id, gate_type=body.gate_type, disposition=body.disposition
        )
        session.add(ov)
    else:
        ov.disposition = body.disposition
    await session.flush()
    await session.refresh(ov)
    return OrgGateOverrideResponse.model_validate(ov)


@router.delete("/overrides/org/{id}", status_code=200)
async def delete_org_override(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    r = await session.execute(
        select(OrgGateOverride).where(OrgGateOverride.id == id, OrgGateOverride.org_id == org_id)
    )
    ov = r.scalar_one_or_none()
    if ov is None:
        raise HTTPException(status_code=404, detail="Override not found")
    await session.delete(ov)
    await session.flush()
    return {"ok": True}


# ── member overrides ───────────────────────────────────────────────────────────

@router.post("/overrides/member", response_model=MemberGateOverrideResponse, status_code=201)
async def upsert_member_override(
    body: MemberGateOverrideCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> MemberGateOverrideResponse:
    r = await session.execute(
        select(MemberGateOverride).where(
            MemberGateOverride.org_id == org_id,
            MemberGateOverride.member_id == body.member_id,
            MemberGateOverride.gate_type == body.gate_type,
        ).limit(1)
    )
    mo = r.scalar_one_or_none()
    if mo is None:
        mo = MemberGateOverride(
            id=uuid.uuid4(), org_id=org_id,
            member_id=body.member_id, gate_type=body.gate_type, disposition=body.disposition
        )
        session.add(mo)
    else:
        mo.disposition = body.disposition
    await session.flush()
    await session.refresh(mo)
    return MemberGateOverrideResponse.model_validate(mo)


@router.delete("/overrides/member/{id}", status_code=200)
async def delete_member_override(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    r = await session.execute(
        select(MemberGateOverride).where(
            MemberGateOverride.id == id, MemberGateOverride.org_id == org_id
        )
    )
    mo = r.scalar_one_or_none()
    if mo is None:
        raise HTTPException(status_code=404, detail="Override not found")
    await session.delete(mo)
    await session.flush()
    return {"ok": True}


# ── resolve disposition ────────────────────────────────────────────────────────

@router.post("/resolve", response_model=ResolveResponse)
async def resolve(
    body: ResolveRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> ResolveResponse:
    """(member, role, gate_type) → disposition 해소.

    precedence: member_override > org_override > org_posture > system_default(ask).
    risk_level 입력 없음 — 플랫폼 위험도 판정 안 함.
    """
    disposition = await resolve_disposition(
        session, org_id, body.member_id, body.role_id, body.gate_type
    )
    return ResolveResponse(
        disposition=disposition,
        member_id=body.member_id,
        role_id=body.role_id,
        gate_type=body.gate_type,
    )
