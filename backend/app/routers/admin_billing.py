"""story #2777(E-ADMIN-REDESIGN·결제 운영) — 어드민 처리 액션(빌링 재시도·사용권 부여).

⛔prod 전면 차단(하드가드, 라우터 레벨) — dev/develop만 통과. mutation=OSS backend
단독 소유(PO 確定 안A) — internal-api는 이 테이블들을 GET만 한다(경계 무변경)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.admin_auth import AdminOperator, require_admin_operator
from app.dependencies.database import get_db
from app.services.admin_billing import AdminBillingError, GrantTier, grant_credit, retry_billing_order

router = APIRouter(prefix="/api/v2/admin", tags=["admin"])


def _reject_prod() -> None:
    if settings.is_prod_deploy:
        raise HTTPException(status_code=403, detail="admin billing mutation actions are disabled in prod")


class RetryBillingRequest(BaseModel):
    order_id: str


class CreditGrantRequest(BaseModel):
    target_tier: GrantTier
    months: int = Field(..., ge=1, le=12)
    reason: str = Field(..., min_length=1)
    amount_minor: int = Field(..., gt=0)
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
        order = await retry_billing_order(session, org_id=org_id, order_id=body.order_id)
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return {"order_id": order.order_id, "status": order.status}


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
            reason=body.reason, amount_minor=body.amount_minor, currency=body.currency,
            idempotency_key=idempotency_key, actor_email=operator.email,
        )
    except AdminBillingError as e:
        raise HTTPException(status_code=e.status_code, detail={"code": e.code, "message": e.message}) from e
    return {
        "entry_id": str(entry.id),
        "target_tier": entry.entry_metadata["target_tier"],
        "current_period_end": entry.entry_metadata["grant_expires_at"],
    }
