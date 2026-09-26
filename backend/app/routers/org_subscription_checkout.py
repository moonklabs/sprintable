"""결제②-D선행(story #2502+#2506) — 구독 체크아웃 엔드포인트. FE가 Toss 위젯 카드 인증을
마친 뒤 이 엔드포인트로 authKey+선택한 tier/billing_cycle을 전달한다.

인증 패턴은 C1(billing_keys.py)과 동일 — org-wide 작업(특정 project와 무관)이라
``get_verified_org_id_no_project_gate``를 쓴다(story #2486 교훈)."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.billing_payment_attempt import BillingPaymentAttempt
from app.models.org_subscription import OrgSubscription
from app.services import billing_payment_attempt as attempts
from app.services.org_subscription_checkout import (
    ActivePaidSubscriptionExists,
    CheckoutError,
    CheckoutInProgress,
)
from app.services.org_subscription_tier_change import (
    TierChangeError,
    TierChangeInProgress,
)
from app.services.platform_settings import get_platform_settings, require_billing_checkout_enabled

router = APIRouter(prefix="/api/v2/org-subscriptions", tags=["billing", "Organization"])


class CheckoutRequest(BaseModel):
    # story #4335 — 브라우저가 카드 인증(위젯) 가기 전에 만든 시도 id(멱등 키). 같은 id로 다시 오면 새 작업 없이 그 시도 상태.
    attempt_id: uuid.UUID
    auth_key: str
    tier: Literal["starter", "team", "business"]
    billing_cycle: Literal["monthly", "annual"]


class ChangeTierRequest(BaseModel):
    attempt_id: uuid.UUID
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


class PaymentAttemptResponse(BaseModel):
    """story #4335 — 결제 시도 상태. `status`: processing(결과 대기 — 조회로 확정) · succeeded · declined(카드사 거절 · 청구 0) ·
    failed(청구 0이 행으로 증명된 실패) · voided(청구됐지만 권리를 못 줘 전액 환불 — `refund_status`). `reauth_required`면 카드 인증부터 다시(authKey 1회용). `subscription`은 끝난 뒤에만."""

    attempt_id: uuid.UUID
    kind: str
    status: str
    tier: str
    billing_cycle: str | None
    declined_reason: str | None = None
    reauth_required: bool = False
    # voided(청구됐지만 권리를 못 줘 전액 환불) · change-tier 부분 환불의 상태 — pending / confirmed / failed를 구별해 내린다.
    refund_status: str | None = None
    subscription: CheckoutResponse | None = None


async def _attempt_response(session: AsyncSession, attempt: BillingPaymentAttempt) -> PaymentAttemptResponse:
    subscription = None
    if attempt.status != "processing":
        sub = (
            await session.execute(
                select(OrgSubscription).where(OrgSubscription.org_id == attempt.org_id).execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        subscription = _to_response(sub) if sub is not None else None
    return PaymentAttemptResponse(
        attempt_id=attempt.id, kind=attempt.kind, status=attempt.status, tier=attempt.tier,
        billing_cycle=attempt.billing_cycle,
        declined_reason=attempt.reason if attempt.status == "declined" else None,
        reauth_required=attempt.reauth_required, refund_status=attempt.refund_status, subscription=subscription,
    )


async def _require_admin(session: AsyncSession, auth: AuthContext, org_id: uuid.UUID) -> None:
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")


def _to_response(sub: OrgSubscription, *, declined_reason: str | None = None) -> CheckoutResponse:
    return CheckoutResponse(
        org_id=sub.org_id, tier=sub.tier, billing_cycle=sub.billing_cycle, status=sub.status,
        current_period_start=sub.current_period_start.isoformat() if sub.current_period_start else None,
        current_period_end=sub.current_period_end.isoformat() if sub.current_period_end else None,
        declined_reason=declined_reason,
        pending_tier=sub.pending_tier,
        pending_change_apply_at=sub.pending_change_apply_at.isoformat() if sub.pending_change_apply_at else None,
    )


@router.post("/checkout", response_model=PaymentAttemptResponse, status_code=202)
async def checkout(
    body: CheckoutRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> PaymentAttemptResponse:
    """카드 인증 완료(authKey) → 결제 시도를 만들고 곧바로 202 `{attempt_id, status: processing}`(story #4335). 빌링키 발급 ·
    즉시 1차 청구 · active 전이는 응답 뒤 작업이 몰고, 결과는 `GET /attempts/{attempt_id}`로 확정한다(끊긴 뒤 재요청이 아니라
    조회). 같은 `attempt_id`로 다시 오면 새 작업 없이 그 시도 상태(끝났으면 200).

    story #2728(선생님 결정②) — Toss 심사 완료 前엔 이 엔드포인트가 서버측에서 무조건
    거부한다(FE 버튼 숨김만으로는 반쪽 — 「금지 AC=서버가 거부」). 어드민에서 스위치를
    켜야만(sprintable-admin/internal-api 경유) 도달 가능해진다. auth 체크보다 먼저 —
    기능 자체가 꺼진 상태에선 호출자의 org 권한과 무관하게 전원 차단이 정답."""
    settings = await get_platform_settings(session)
    require_billing_checkout_enabled(settings)
    await _require_admin(session, auth, org_id)

    try:
        attempt, token = await attempts.start_checkout_attempt(
            session, attempt_id=body.attempt_id, org_id=org_id, requested_by=uuid.UUID(auth.user_id),
            tier=body.tier, billing_cycle=body.billing_cycle,
        )
    except attempts.AttemptNotFound as exc:
        raise HTTPException(status_code=404, detail="payment attempt not found") from exc
    except CheckoutInProgress as exc:
        # #2511 — 같은 org의 다른 결제가 진행 中. 사용자 입력·내부 상태 오류가 아니라
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

    if token is not None:
        background_tasks.add_task(attempts.run_attempt, attempt.id, token, auth_key=body.auth_key)
    if attempt.status != "processing":
        response.status_code = 200
    return await _attempt_response(session, attempt)


@router.post("/change-tier", response_model=PaymentAttemptResponse, status_code=202)
async def change_tier_endpoint(
    body: ChangeTierRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> PaymentAttemptResponse:
    """story #2880(결제 트랙 갭①, 선생님 최종 확定 2026-08-21) — 월납 유료→유료 상향.
    신 offering 전액 즉시 청구 → confirmed 後 tier+과금일(period) 즉시 리셋 → 직전
    결제 건에 잔여기간 일할 부분취소(Toss cancel). checkout과 달리 authKey 불요(기존
    active billing_key로 즉시 청구).

    story #4335 — checkout과 같은 결제 시도 흐름: 곧바로 202 · 결과는 `GET /attempts/{attempt_id}`. 정책 위반(하향 · 연납 ·
    활성 유료 아님 등)은 시도를 만들기 전에 400 — 호출자가 고칠 수 있는 입력 오류."""
    settings = await get_platform_settings(session)
    require_billing_checkout_enabled(settings)
    await _require_admin(session, auth, org_id)

    try:
        attempt, token = await attempts.start_change_tier_attempt(
            session, attempt_id=body.attempt_id, org_id=org_id, requested_by=uuid.UUID(auth.user_id),
            new_tier=body.new_tier,
        )
    except attempts.AttemptNotFound as exc:
        raise HTTPException(status_code=404, detail="payment attempt not found") from exc
    except TierChangeInProgress as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TierChangeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if token is not None:
        background_tasks.add_task(attempts.run_attempt, attempt.id, token)
    if attempt.status != "processing":
        response.status_code = 200
    return await _attempt_response(session, attempt)


@router.get("/attempts/{attempt_id}", response_model=PaymentAttemptResponse)
async def get_payment_attempt(
    attempt_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> PaymentAttemptResponse:
    """story #4335 — 결제 시도 상태 조회. 진행 중인데 모는 쪽 기한이 지났으면 여기서 이어받아(Toss는 조회만) 결론을 낸다 —
    응답 뒤 작업이 멈췄거나 사라져도 이 조회가 마무리한다. 새로고침 · 재진입도 이 조회로 같은 결과."""
    await _require_admin(session, auth, org_id)
    try:
        await attempts.get_attempt(session, attempt_id, org_id=org_id)
        attempt = await attempts.reconcile_attempt(session, attempt_id)
    except attempts.AttemptNotFound as exc:
        raise HTTPException(status_code=404, detail="payment attempt not found") from exc
    return await _attempt_response(session, attempt)


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
    require_billing_checkout_enabled(settings)

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
    require_billing_checkout_enabled(settings)

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    from app.services.org_subscription_downgrade import DowngradeError, cancel_pending_downgrade

    try:
        sub = await cancel_pending_downgrade(session, org_id=org_id)
    except DowngradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _to_response(sub)


@router.post("/cancel", response_model=CheckoutResponse)
async def cancel_subscription_endpoint(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """story #2882(구독 취소) — 「tier=free로의 하향」으로 예약(같은 pending_* 슬롯·같은
    sweep). 즉시 전이 없음 — 현재 기간 말까지 사용, 다음 갱신 중지, 부분 환불 없음
    (v2.1 §12). 좌석 게이트는 타지 않는다(해지 의사는 좌석 초과를 이유로 거부하지
    않는다 — `org_subscription_downgrade.cancel_subscription` docstring 참고)."""
    settings = await get_platform_settings(session)
    require_billing_checkout_enabled(settings)

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    from app.services.org_subscription_downgrade import DowngradeError, cancel_subscription

    try:
        sub = await cancel_subscription(session, org_id=org_id)
    except DowngradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _to_response(sub)


@router.delete("/cancel", response_model=CheckoutResponse)
async def revoke_cancellation_endpoint(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
) -> CheckoutResponse:
    """story #2882 — 취소 철회(재구독 의사). 같은 pending_* 슬롯이라
    `cancel_pending_downgrade`를 그대로 재사용(재구현 0) — 예약된 게 하향이든
    취소(free)든 pending_*만 클리어하는 동작은 동일하다."""
    settings = await get_platform_settings(session)
    require_billing_checkout_enabled(settings)

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org admin/owner role required")

    from app.services.org_subscription_downgrade import DowngradeError, cancel_pending_downgrade

    try:
        sub = await cancel_pending_downgrade(session, org_id=org_id)
    except DowngradeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _to_response(sub)
