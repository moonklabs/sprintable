"""story #2777(E-ADMIN-REDESIGN·결제 운영) — 어드민 처리 액션(빌링 재시도·사용권 부여).

⛔prod 전면 차단(하드가드, 라우터 레벨) — dev/develop만 통과. mutation=OSS backend
단독 소유(PO 確定 안A) — internal-api는 이 테이블들을 GET만 한다(경계 무변경)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.admin_auth import AdminOperator, require_admin_operator
from app.dependencies.database import get_db
from app.models.grandfather_policy import GrandfatherPolicy
from app.models.offering_version import OfferingVersion
from app.services.admin_billing import (
    AdminBillingError,
    GrantTier,
    create_grandfather_policy,
    create_offering_version,
    grant_credit,
    reset_billing_key,
    retry_billing_order,
)

router = APIRouter(prefix="/api/v2/admin", tags=["admin"])

OfferingTier = Literal["free", "starter", "team", "business"]
OfferingCurrency = Literal["usd", "krw"]


def _reject_prod() -> None:
    if settings.is_prod_deploy:
        raise HTTPException(status_code=403, detail="admin billing mutation actions are disabled in prod")


class RetryBillingRequest(BaseModel):
    order_id: str


class CreditGrantRequest(BaseModel):
    target_tier: GrantTier
    months: int = Field(..., ge=1, le=12)
    reason: str = Field(..., min_length=1)
    # PO 지적③(판정 변경) — amount_minor는 어드민 자유입력이 아니라 서버가
    # offering_versions(checkout과 동일 가격 원천)에서 파생한다. 이 필드는 애초에
    # request body에 없다(유나 UI 인계 doc도 이 필드 없이 짜여 있었음 — 결과적으로 정합).
    currency: str = "krw"


@router.post("/orgs/{org_id}/billing/retry")
async def retry_billing(
    org_id: uuid.UUID,
    body: RetryBillingRequest,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> dict:
    _reject_prod()
    try:
        order = await retry_billing_order(session, org_id=org_id, order_id=body.order_id, actor_email=operator.email)
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return {"order_id": order.order_id, "status": order.status}


@router.post("/orgs/{org_id}/billing/reset-billing-key")
async def reset_billing_key_endpoint(
    org_id: uuid.UUID,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """story #2989 AC3 — 테스트/운영 개입용 결제수단 초기화. retry_billing과 동형(admin
    인가+prod 차단+구조화 audit). 셀프서브(billing_keys.py DELETE)와 같은 레일
    (revoke_billing_key)을 타되 활성 구독 차단을 우회한다(force=True, reset_billing_key
    docstring 참고)."""
    _reject_prod()
    try:
        result = await reset_billing_key(session, org_id=org_id, actor_email=operator.email)
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return result


@router.post("/orgs/{org_id}/billing/credit-grant")
async def credit_grant(
    org_id: uuid.UUID,
    body: CreditGrantRequest,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> dict:
    _reject_prod()
    try:
        entry = await grant_credit(
            session, org_id=org_id, target_tier=body.target_tier, months=body.months,
            reason=body.reason, currency=body.currency,
            idempotency_key=idempotency_key, actor_email=operator.email,
        )
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return {
        "entry_id": str(entry.id),
        "target_tier": entry.entry_metadata["target_tier"],
        "current_period_end": entry.entry_metadata["grant_expires_at"],
    }


# ─────────────────────────────────────────────────────────────────────────
# story #2474 — offering_version/grandfather_policy 어드민 CRUD. 값 「수정」 엔드포인트는
# 의도적으로 없다 — append-only(effective_from/effective_to)이므로 새 값=새 행(CREATE)뿐.
# 이 부재 자체가 계약이다(test_admin_billing_router_surface_realdb.py가 라우터 표면을
# 값으로 단언 — 나중에 PATCH/PUT이 조용히 추가되면 그 테스트가 실패한다, PO 보강ⓐ).
# ─────────────────────────────────────────────────────────────────────────

class OfferingVersionCreateRequest(BaseModel):
    tier: OfferingTier
    currency: OfferingCurrency
    version_label: str = Field(..., min_length=1)
    monthly_price_minor: int = Field(..., ge=0)
    annual_price_minor: int = Field(..., ge=0)
    included_seats: int = Field(..., ge=0)
    extra_seat_price_minor: int | None = Field(default=None, ge=0)
    max_agents: int | None = Field(default=None, ge=0)
    au_limit: int = Field(..., ge=0)
    realtime_connection_limit: int = Field(..., ge=0)
    storage_mb_limit: int = Field(..., ge=0)
    max_file_mb: int = Field(..., ge=0)
    lab_credit_minor: int = Field(..., ge=0)
    rate_limit_per_min: int = Field(..., ge=0)
    automation_rule_limit: int = Field(..., ge=0)
    webhook_limit: int = Field(..., ge=0)
    event_replay_days: int = Field(..., ge=0)
    overage_allowed: bool
    pack_catalog: dict | None = None


class OfferingVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tier: str
    currency: str
    version_label: str
    monthly_price_minor: int
    annual_price_minor: int
    included_seats: int
    extra_seat_price_minor: int | None
    max_agents: int | None
    au_limit: int
    realtime_connection_limit: int
    storage_mb_limit: int
    max_file_mb: int
    lab_credit_minor: int
    rate_limit_per_min: int
    automation_rule_limit: int
    webhook_limit: int
    event_replay_days: int
    overage_allowed: bool
    pack_catalog: dict | None
    effective_from: datetime
    effective_to: datetime | None
    created_by: str
    created_at: datetime


class GrandfatherPolicyCreateRequest(BaseModel):
    org_id: uuid.UUID
    offering_version_id: uuid.UUID
    auto_migrate_on_new_version: bool = False
    grace_period_days: int | None = Field(default=None, ge=0)
    reason: str = Field(..., min_length=1)


class GrandfatherPolicyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    offering_version_id: uuid.UUID
    auto_migrate_on_new_version: bool
    grace_period_days: int | None
    reason: str
    effective_from: datetime
    effective_to: datetime | None
    created_by: str
    created_at: datetime


@router.post("/offering-versions", response_model=OfferingVersionResponse)
async def create_offering_version_endpoint(
    body: OfferingVersionCreateRequest,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> OfferingVersionResponse:
    _reject_prod()
    new_version = await create_offering_version(session, actor_email=operator.email, **body.model_dump())
    return OfferingVersionResponse.model_validate(new_version)


@router.get("/offering-versions", response_model=list[OfferingVersionResponse])
async def list_offering_versions(
    tier: OfferingTier | None = None,
    currency: OfferingCurrency | None = None,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> list[OfferingVersionResponse]:
    q = select(OfferingVersion)
    if tier is not None:
        q = q.where(OfferingVersion.tier == tier)
    if currency is not None:
        q = q.where(OfferingVersion.currency == currency)
    # PO 보강ⓑ(2026-08-21, #2864 학습 재적용) — 히스토리 목록은 정렬을 명시하지 않으면
    # DB가 물리 순서를 그대로 줄 수 있어 비결정적. effective_from desc로 고정.
    q = q.order_by(OfferingVersion.effective_from.desc(), OfferingVersion.id.desc())
    rows = (await session.execute(q)).scalars().all()
    return [OfferingVersionResponse.model_validate(r) for r in rows]


@router.post("/grandfather-policies", response_model=GrandfatherPolicyResponse)
async def create_grandfather_policy_endpoint(
    body: GrandfatherPolicyCreateRequest,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> GrandfatherPolicyResponse:
    _reject_prod()
    try:
        new_policy = await create_grandfather_policy(session, actor_email=operator.email, **body.model_dump())
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return GrandfatherPolicyResponse.model_validate(new_policy)


@router.get("/grandfather-policies", response_model=list[GrandfatherPolicyResponse])
async def list_grandfather_policies(
    org_id: uuid.UUID | None = None,
    operator: AdminOperator = Depends(require_admin_operator),
    session: AsyncSession = Depends(get_db),
) -> list[GrandfatherPolicyResponse]:
    q = select(GrandfatherPolicy)
    if org_id is not None:
        q = q.where(GrandfatherPolicy.org_id == org_id)
    q = q.order_by(GrandfatherPolicy.effective_from.desc(), GrandfatherPolicy.id.desc())
    rows = (await session.execute(q)).scalars().all()
    return [GrandfatherPolicyResponse.model_validate(r) for r in rows]
