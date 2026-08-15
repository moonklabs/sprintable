"""결제②-D선행(story #2502+#2506) — 구독 체크아웃 엔드포인트. FE가 Toss 위젯 카드 인증을
마친 뒤 이 엔드포인트로 authKey+선택한 tier/billing_cycle을 전달한다.

인증 패턴은 C1(billing_keys.py)과 동일 — org-wide 작업(특정 project와 무관)이라
``get_verified_org_id_no_project_gate``를 쓴다(story #2486 교훈)."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.org_subscription import OrgSubscription
from app.services.org_subscription_checkout import (
    CheckoutDeclined,
    CheckoutError,
    CheckoutInProgress,
    checkout_subscription,
)

router = APIRouter(prefix="/api/v2/org-subscriptions", tags=["billing", "Organization"])


class CheckoutRequest(BaseModel):
    auth_key: str
    tier: Literal["starter", "team", "business"]
    billing_cycle: Literal["monthly", "annual"]


class CheckoutResponse(BaseModel):
    org_id: uuid.UUID
    tier: str
    billing_cycle: str | None
    status: str
    current_period_start: str | None = None
    current_period_end: str | None = None
    declined_reason: str | None = None

    model_config = {"from_attributes": True}


def _to_response(sub: OrgSubscription, *, declined_reason: str | None = None) -> CheckoutResponse:
    return CheckoutResponse(
        org_id=sub.org_id, tier=sub.tier, billing_cycle=sub.billing_cycle, status=sub.status,
        current_period_start=sub.current_period_start.isoformat() if sub.current_period_start else None,
        current_period_end=sub.current_period_end.isoformat() if sub.current_period_end else None,
        declined_reason=declined_reason,
    )


@router.post("/checkout", response_model=CheckoutResponse)
async def checkout(
    body: CheckoutRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """카드 인증 완료(authKey) → 빌링키 발급 + 구독 pending 생성 + 즉시 1차 청구 →
    청구 성공 時에만 active. 청구가 카드 거절 등으로 실패하면 200으로 status='pending'
    바디를 반환한다(시스템 오류가 아니라 재시도 가능한 비즈니스 결과 — 502는 Toss API
    자체에 도달 못 한 진짜 시스템 오류에만 쓴다)."""
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    try:
        sub = await checkout_subscription(
            session, org_id=org_id, auth_key=body.auth_key, tier=body.tier, billing_cycle=body.billing_cycle,
        )
    except CheckoutDeclined as exc:
        return _to_response(exc.subscription, declined_reason=str(exc))
    except CheckoutInProgress as exc:
        # #2511 — 같은 org의 다른 checkout이 진행 中. 사용자 입력·내부 상태 오류가 아니라
        # 타이밍 충돌이라 409(재시도 가능함을 뜻함).
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except CheckoutError as exc:
        # 이 지점 도달 시 tier/billing_cycle 자체는 이미 Pydantic Literal이 걸렀다 —
        # 남은 원인은 offering_version 카탈로그 갭 같은 내부 상태 문제(사용자 입력 오류
        # 아님)라 422가 아니라 500.
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _to_response(sub)
