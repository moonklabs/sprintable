"""결제②-후속(story #2505) — 팩 구매 엔드포인트. org 관리자가 offering_version.
pack_catalog에 정의된 자원의 팩을 명시적으로 구매한다.

인증 패턴은 C1/#2506과 동일 — org-wide 작업이라 ``get_verified_org_id_no_project_gate``
(story #2486 교훈)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.billing_order import BillingOrder
from app.services.billing_pack import PackPurchaseDeclined, PackPurchaseError, purchase_packs
from app.services.platform_settings import get_platform_settings, require_billing_checkout_enabled

router = APIRouter(prefix="/api/v2/org-subscriptions", tags=["billing", "Organization"])


class PackPurchaseRequest(BaseModel):
    resource: str
    quantity: int = Field(ge=1, default=1)
    # FE가 클릭당 고유 UUID를 생성해 전달 — 같은 클릭 재시도(네트워크 재시도 등)는 같은
    # 키로 와야 charge_org의 원자적 claim이 중복 청구를 막는다. 새 구매 의도는 새 키.
    idempotency_key: str


class PackPurchaseResponse(BaseModel):
    org_id: uuid.UUID
    resource: str
    quantity: int
    status: str
    declined_reason: str | None = None

    model_config = {"from_attributes": True}


def _to_response(order: BillingOrder, *, resource: str, quantity: int, declined_reason: str | None = None) -> PackPurchaseResponse:
    return PackPurchaseResponse(
        org_id=order.org_id, resource=resource, quantity=quantity, status=order.status,
        declined_reason=declined_reason,
    )


@router.post("/packs", response_model=PackPurchaseResponse)
async def purchase_pack(
    body: PackPurchaseRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> PackPurchaseResponse:
    """명시 구매 확認 → 즉시 청구(#2506 checkout과 동형) → confirmed 時 원장 확定.
    카드 거절은 200+status='failed'(비즈니스 결과) — 502는 Toss API 자체 미도달에만.

    story #2728(선생님 결정②) — 팩 구매도 실제 결제 처리라 checkout과 동일 스위치로
    서버측 전면 차단. 카디르 QA(PR#3460) — org_subscription_checkout.py의 6개 진입점과
    같은 헬퍼(require_billing_checkout_enabled)를 공유해 판정이 갈라지지 않게 한다."""
    platform_settings = await get_platform_settings(session)
    require_billing_checkout_enabled(platform_settings)

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    try:
        order = await purchase_packs(
            session, org_id=org_id, resource=body.resource, quantity=body.quantity,
            idempotency_key=body.idempotency_key,
        )
    except PackPurchaseDeclined as exc:
        return _to_response(exc.order, resource=body.resource, quantity=body.quantity, declined_reason=str(exc))
    except PackPurchaseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _to_response(order, resource=body.resource, quantity=body.quantity)
