"""결제②-후속(story #2505) — 팩 구매 트리거. offering_version.pack_catalog(자원별
{unit, price_minor, max_packs})에 정의된 자원을 org 관리자가 "명시적으로" 구매하는
경로(v2.1 §11.1 — ⛔자동 초과청구 없음, 이 함수가 그 유일한 write 경로).

즉시 결제(#2506 checkout과 동형 판단 — trigger_due_charges가 아직 미배선이라 "나중에
합산 청구"할 스케줄이 없다·팩은 즉시 용량 확장이 목적이라 즉시결제가 자연스러움)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.payment.toss_adapter import TossApiError


class PackPurchaseError(Exception):
    """팩 구매를 진행할 수 없는 상태 — 명시 실패."""


class PackPurchaseDeclined(Exception):
    """카드 거절 등 비즈니스 사유로 즉시 청구가 실패 — 시스템 오류가 아님(체크아웃의
    CheckoutDeclined와 동형)."""

    def __init__(self, message: str, *, order: BillingOrder):
        self.order = order
        super().__init__(message)


async def _packs_purchased_this_period(
    session: AsyncSession, *, org_id: uuid.UUID, resource: str, price_minor: int,
    period_start: datetime, period_end: datetime,
) -> int:
    """이번 결제 주기 동안 이 자원의 팩을 몇 개 샀는지 — 원장(A2, 정본)에서 파생한다
    (별도 카운터 컬럼 두지 않음, v2.1 원장설계 원칙: 원장이 유일한 진실). amount_minor
    합계를 단가로 나눠 개수로 환산(offering_version 불변이라 주기 내 단가는 고정)."""
    total_amount = (
        await session.execute(
            text(
                "SELECT COALESCE(SUM(amount_minor), 0) FROM billing_ledger_entries "
                "WHERE org_id = :oid AND entry_type = 'pack_purchase' "
                "AND metadata->>'resource' = :resource AND ts >= :start AND ts < :end"
            ),
            {"oid": org_id, "resource": resource, "start": period_start, "end": period_end},
        )
    ).scalar_one()
    return int(total_amount) // price_minor if price_minor else 0


async def purchase_packs(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    resource: str,
    quantity: int,
    idempotency_key: str,
) -> BillingOrder:
    """org_subscription이 active인 org가 resource 팩을 quantity개 명시 구매. 즉시
    charge_org(entry_type="pack_purchase")로 청구 — confirmed 時 원장 확정."""
    if quantity < 1:
        raise PackPurchaseError(f"quantity must be >= 1, got {quantity!r}")
    if not idempotency_key:
        raise PackPurchaseError("idempotency_key is required")

    sub = (
        await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))
    ).scalar_one_or_none()
    if sub is None or sub.status != "active" or sub.offering_version_id is None:
        raise PackPurchaseError(f"org_id={org_id}에 활성 유료 구독이 없음 — 팩 구매 대상 아님")

    offering = await session.get(OfferingVersion, sub.offering_version_id)
    if offering is None:
        raise PackPurchaseError(f"offering_version {sub.offering_version_id}를 찾을 수 없음")

    pack_catalog = offering.pack_catalog or {}
    pack = pack_catalog.get(resource)
    if pack is None:
        raise PackPurchaseError(
            f"resource={resource!r}는 tier={offering.tier!r}에서 판매하지 않음"
            f"(판매 자원: {sorted(pack_catalog)})"
        )

    price_minor = pack["price_minor"]
    max_packs = pack.get("max_packs")
    if max_packs is not None:
        if sub.current_period_start is None or sub.current_period_end is None:
            raise PackPurchaseError(f"org_id={org_id}의 current_period가 세팅되지 않아 max_packs 판정 불가")
        already = await _packs_purchased_this_period(
            session, org_id=org_id, resource=resource, price_minor=price_minor,
            period_start=sub.current_period_start, period_end=sub.current_period_end,
        )
        if already + quantity > max_packs:
            raise PackPurchaseError(
                f"resource={resource!r} max_packs={max_packs} 초과 — 이번 주기 이미 {already}개 "
                f"구매, {quantity}개 추가 요청"
            )

    amount_minor = price_minor * quantity
    order_id = f"pack:{org_id}:{idempotency_key}"

    try:
        order = await charge_org(
            session, org_id=org_id, order_id=order_id, amount_minor=amount_minor,
            currency=offering.currency, order_name=f"Sprintable {resource} 팩 {quantity}개",
            entry_type="pack_purchase",
            ledger_metadata={"resource": resource, "quantity": quantity, "unit": pack["unit"]},
        )
    except TossApiError as exc:
        failed_order = (
            await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
        ).scalar_one()
        raise PackPurchaseDeclined(str(exc), order=failed_order) from exc

    return order
