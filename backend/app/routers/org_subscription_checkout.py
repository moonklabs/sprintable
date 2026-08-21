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
    ActivePaidSubscriptionExists,
    CheckoutDeclined,
    CheckoutError,
    CheckoutInProgress,
    checkout_subscription,
)
from app.services.org_subscription_tier_change import (
    TierChangeDeclined,
    TierChangeError,
    TierChangeInProgress,
    change_tier,
)
from app.services.platform_settings import get_platform_settings

router = APIRouter(prefix="/api/v2/org-subscriptions", tags=["billing", "Organization"])


class CheckoutRequest(BaseModel):
    auth_key: str
    tier: Literal["starter", "team", "business"]
    billing_cycle: Literal["monthly", "annual"]


class ChangeTierRequest(BaseModel):
    new_tier: Literal["starter", "team", "business"]


class DowngradeRequest(BaseModel):
    new_tier: Literal["starter", "team", "business"]


class CheckoutResponse(BaseModel):
    org_id: uuid.UUID
    tier: str
    billing_cycle: str | None
    status: str
    current_period_start: str | None = None
    current_period_end: str | None = None
    declined_reason: str | None = None
    # story #2881 — 예약된 하향이 있으면 어드민/사용자 표면에 노출(페드루 지시: 응답
    # 스키마에 pending 노출 포함). 예약 없으면 셋 다 None(가장 흔한 상태).
    pending_tier: str | None = None
    pending_change_apply_at: str | None = None

    model_config = {"from_attributes": True}


def _to_response(sub: OrgSubscription, *, declined_reason: str | None = None) -> CheckoutResponse:
    return CheckoutResponse(
        org_id=sub.org_id, tier=sub.tier, billing_cycle=sub.billing_cycle, status=sub.status,
        current_period_start=sub.current_period_start.isoformat() if sub.current_period_start else None,
        current_period_end=sub.current_period_end.isoformat() if sub.current_period_end else None,
        declined_reason=declined_reason,
        pending_tier=sub.pending_tier,
        pending_change_apply_at=sub.pending_change_apply_at.isoformat() if sub.pending_change_apply_at else None,
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
    자체에 도달 못 한 진짜 시스템 오류에만 쓴다).

    story #2728(선생님 결정②) — Toss 심사 완료 前엔 이 엔드포인트가 서버측에서 무조건
    거부한다(FE 버튼 숨김만으로는 반쪽 — 「금지 AC=서버가 거부」). 어드민에서 스위치를
    켜야만(sprintable-admin/internal-api 경유) 도달 가능해진다. auth 체크보다 먼저 —
    기능 자체가 꺼진 상태에선 호출자의 org 권한과 무관하게 전원 차단이 정답."""
    settings = await get_platform_settings(session)
    if not settings.billing_checkout_enabled:
        raise HTTPException(status_code=403, detail="billing checkout is not yet enabled")

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
    except ActivePaidSubscriptionExists as exc:
        # ⛔P0(story a8fec107) — 호출자가 고칠 수 있는 입력 오류(잘못된 엔드포인트 진입)라
        # 400. 메시지 자체가 정확한 복구 행동(change-tier)을 명시한다.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CheckoutError as exc:
        # 이 지점 도달 시 tier/billing_cycle 자체는 이미 Pydantic Literal이 걸렀다 —
        # 남은 원인은 offering_version 카탈로그 갭 같은 내부 상태 문제(사용자 입력 오류
        # 아님)라 422가 아니라 500.
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _to_response(sub)


@router.post("/change-tier", response_model=CheckoutResponse)
async def change_tier_endpoint(
    body: ChangeTierRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """story #2880(결제 트랙 갭①, 선생님 최종 확定 2026-08-21) — 월납 유료→유료 상향.
    신 offering 전액 즉시 청구 → confirmed 後 tier+과금일(period) 즉시 리셋 → 직전
    결제 건에 잔여기간 일할 부분취소(Toss cancel). checkout과 달리 authKey 불요(기존
    active billing_key로 즉시 청구) — 신규 결제(checkout)와는 별개 진입점이다.

    청구가 카드 거절로 실패하면 200으로 status=원 tier 그대로인 바디를 반환한다
    (checkout과 동형 — 재시도 가능한 비즈니스 결과, 502는 Toss API 자체에 도달 못 한
    시스템 오류에만). 정책 위반(하향·연납·활성 유료 아님 등)은 400 — 캐치가능한
    호출자 입력 오류로 분류(checkout의 CheckoutError=500과 다른 이유: 그쪽은 카탈로그
    갭 같은 순수 내부 상태 문제뿐이지만, 이쪽은 «잘못된 대상 tier 선택»이 호출자가 고칠
    수 있는 흔한 경로다)."""
    settings = await get_platform_settings(session)
    if not settings.billing_checkout_enabled:
        raise HTTPException(status_code=403, detail="billing checkout is not yet enabled")

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    try:
        sub = await change_tier(session, org_id=org_id, new_tier=body.new_tier)
    except TierChangeDeclined as exc:
        return _to_response(exc.subscription, declined_reason=str(exc))
    except TierChangeInProgress as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TierChangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return _to_response(sub)


@router.post("/downgrade", response_model=CheckoutResponse)
async def reserve_downgrade_endpoint(
    body: DowngradeRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """story #2881(결제 트랙 갭②) — 하향 예약. 즉시 전이 없음 — 다음 갱신일부터 적용
    (부분 환불 없음, v2.2 D10). 단일 슬롯이라 재호출은 이전 예약을 덮어쓴다(그것도
    이 엔드포인트의 정상 사용 — 재호출=재예약). 응답의 `pending_tier`/
    `pending_change_apply_at`이 예약 상태를 노출한다."""
    settings = await get_platform_settings(session)
    if not settings.billing_checkout_enabled:
        raise HTTPException(status_code=403, detail="billing checkout is not yet enabled")

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    from app.services.org_subscription_downgrade import DowngradeError, reserve_downgrade

    try:
        sub = await reserve_downgrade(session, org_id=org_id, new_tier=body.new_tier)
    except DowngradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _to_response(sub)


@router.delete("/downgrade", response_model=CheckoutResponse)
async def cancel_downgrade_endpoint(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """story #2881 — 예약 철회(재상향 아닌 단순 취소). pending_*만 클리어, 구독 원
    tier는 무변화."""
    settings = await get_platform_settings(session)
    if not settings.billing_checkout_enabled:
        raise HTTPException(status_code=403, detail="billing checkout is not yet enabled")

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    from app.services.org_subscription_downgrade import DowngradeError, cancel_pending_downgrade

    try:
        sub = await cancel_pending_downgrade(session, org_id=org_id)
    except DowngradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _to_response(sub)
