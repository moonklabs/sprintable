"""E-CAGE-REFEREE P3: HITL gate config CRUD + disposition 해소 엔드포인트."""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
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
from app.services.disposition_advisor import DEFAULT_MIN_VERDICTS, get_disposition_recommendation
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
    auth: AuthContext = Depends(get_current_user),
) -> OrgGatePolicyResponse:
    """prod 핫픽스(S20 전수스캔 HIGH, expire-stale 동형): org-admin 게이트 — 이전엔 admin 체크가
    전무해 org 내 임의 멤버가 org 전체 HITL gate posture를 바꿀 수 있었다."""
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
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
    auth: AuthContext = Depends(get_current_user),
) -> OrgGateOverrideResponse:
    """prod 핫픽스(S20 전수스캔 HIGH): org-admin 게이트 추가."""
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
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
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """prod 핫픽스(S20 전수스캔 HIGH): org-admin 게이트 추가."""
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
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
    auth: AuthContext = Depends(get_current_user),
) -> MemberGateOverrideResponse:
    """prod 핫픽스(S20 전수스캔 HIGH): org-admin 게이트 — 이전엔 org 내 임의 멤버가 타 멤버의
    gate override를 조작할 수 있었다."""
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
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
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """prod 핫픽스(S20 전수스캔 HIGH): org-admin 게이트 추가."""
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
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


# ── 동적 조절 추천 + 적용 ──────────────────────────────────────────────────────

class RecommendRequest(BaseModel):
    member_id: uuid.UUID
    role_id: uuid.UUID
    role_key: str
    gate_type: str
    min_verdicts: int = DEFAULT_MIN_VERDICTS
    window_days: int = 90


class ApplyRecommendationRequest(BaseModel):
    member_id: uuid.UUID
    gate_type: str
    disposition: str
    apply_as: str = "member"  # "member" | "org_role"
    role_id: uuid.UUID | None = None


@router.post("/recommendations/suggest")
async def suggest_adjustment(
    body: RecommendRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> dict:
    """신뢰점수 기반 disposition 조정 추천 (조회만, 자동 적용 없음).

    인간이 추천을 검토 후 /recommendations/apply로 승인해야 반영됨.
    저표본 가드: min_verdicts 미달 시 추천 없음.
    """
    return await get_disposition_recommendation(
        session=session,
        org_id=org_id,
        member_id=body.member_id,
        role_id=body.role_id,
        role_key=body.role_key,
        gate_type=body.gate_type,
        min_verdicts=body.min_verdicts,
        window_days=body.window_days,
    )


@router.post("/recommendations/apply")
async def apply_adjustment(
    body: ApplyRecommendationRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """인간 승인 후 override 적용.

    ⚠️ 자동 호출 금지 — 반드시 인간이 추천 검토 후 명시 호출.
    apply_as='member': member_gate_override upsert.
    apply_as='org_role': org_gate_override upsert (role_id 필수).

    prod 핫픽스(S20 전수스캔 — upsert_org_policy/overrides와 동일 클래스, 스캔표엔 5건으로
    적혔지만 이 엔드포인트도 override를 직접 upsert하면서 admin 게이트가 없었다): org-admin 게이트 추가.
    """
    if not await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
    from app.models.hitl_config import DISPOSITIONS

    if body.disposition not in DISPOSITIONS:
        raise HTTPException(status_code=422, detail=f"disposition must be one of {sorted(DISPOSITIONS)}")

    if body.apply_as == "member":
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
                member_id=body.member_id, gate_type=body.gate_type,
                disposition=body.disposition,
            )
            session.add(mo)
        else:
            mo.disposition = body.disposition
        await session.flush()
        return {"applied": True, "apply_as": "member", "disposition": body.disposition}

    if body.apply_as == "org_role":
        if body.role_id is None:
            raise HTTPException(status_code=422, detail="role_id required for org_role apply")
        r = await session.execute(
            select(OrgGateOverride).where(
                OrgGateOverride.org_id == org_id,
                OrgGateOverride.role_id == body.role_id,
                OrgGateOverride.gate_type == body.gate_type,
            ).limit(1)
        )
        oo = r.scalar_one_or_none()
        if oo is None:
            oo = OrgGateOverride(
                id=uuid.uuid4(), org_id=org_id,
                role_id=body.role_id, gate_type=body.gate_type,
                disposition=body.disposition,
            )
            session.add(oo)
        else:
            oo.disposition = body.disposition
        await session.flush()
        return {"applied": True, "apply_as": "org_role", "disposition": body.disposition}

    raise HTTPException(status_code=422, detail="apply_as must be 'member' or 'org_role'")
