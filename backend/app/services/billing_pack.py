"""결제②-후속(story #2505) — 팩 구매 트리거. offering_version.pack_catalog(자원별
{unit, price_minor, max_packs})에 정의된 자원을 org 관리자가 "명시적으로" 구매하는
경로(v2.1 §11.1 — ⛔자동 초과청구 없음, 이 함수가 그 유일한 write 경로).

즉시 결제(#2506 checkout과 동형 판단 — trigger_due_charges가 아직 미배선이라 "나중에
합산 청구"할 스케줄이 없다·팩은 즉시 용량 확장이 목적이라 즉시결제가 자연스러움)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.offering_version import OfferingVersion
from app.models.org_subscription import OrgSubscription
from app.services.billing_charge import charge_org
from app.services.billing_charge_amount import apply_vat_minor
from app.services.payment.toss_adapter import TossApiError
from app.services.platform_settings import get_platform_settings


class PackPurchaseError(Exception):
    """팩 구매를 진행할 수 없는 상태 — 명시 실패."""


class PackPurchaseDeclined(Exception):
    """카드 거절 등 비즈니스 사유로 즉시 청구가 실패 — 시스템 오류가 아님(체크아웃의
    CheckoutDeclined와 동형)."""

    def __init__(self, message: str, *, order: BillingOrder):
        self.order = order
        super().__init__(message)


def _pack_order_id(org_id: uuid.UUID, resource: str, idempotency_key: str) -> str:
    return f"pack:{org_id}:{resource}:{idempotency_key}"


async def _packs_reserved_this_period(
    session: AsyncSession, *, org_id: uuid.UUID, resource: str, taxed_price_minor: int,
    period_start: datetime, period_end: datetime,
) -> int:
    """이번 결제 주기 동안 이 자원의 팩이 몇 개 «예약/구매»됐는지 — billing_orders에서
    파생한다(⚠️billing_ledger_entries가 아니다). 카디르 결함사냥(#2891 리뷰, 2026-08-07)
    발견 TOCTOU: confirmed 원장만 세면, Toss 왕복(최대 60초) 중인 «다른» 동시 구매
    (다른 idempotency_key라 order_id도 안 겹쳐 charge_org의 claim으로도 안 막힘)가 이
    카운트에 안 잡혀 캡을 같이 넘길 수 있었다. pending도 세면(=claim된 순간부터 카운트)
    그 창이 막힌다 — pending으로 남는 order는 실패든 성공이든 이 자원의 «시도 중인
    청구»라 사실상 자리를 차지하는 게 맞다(실패로 끝나면 다음 조회부터 그 order는
    'failed'가 되어 자연히 카운트에서 빠진다).

    story #3097(선생님 결정 2026-08-26) — `billing_orders.amount_minor`는 purchase_packs가
    VAT 가산 後 저장한 값(charge_org로 넘어간 실제 청구액)이라, 개수로 역산하려면 divisor도
    같은 단위(VAT 가산된 개당 가격)여야 한다 — 원가 `price_minor`로 나누면 반올림 누적
    오차로 수량이 큰 구간(예: q=10)에서 개수를 과다산정할 수 있다(직접 대조로 확認)."""
    total_amount = (
        await session.execute(
            text(
                "SELECT COALESCE(SUM(amount_minor), 0) FROM billing_orders "
                "WHERE order_id LIKE :prefix AND status IN ('pending', 'confirmed') "
                "AND created_at >= :start AND created_at < :end"
            ),
            {"prefix": f"pack:{org_id}:{resource}:%", "start": period_start, "end": period_end},
        )
    ).scalar_one()
    return int(total_amount) // taxed_price_minor if taxed_price_minor else 0


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
    settings = await get_platform_settings(session)
    # story #3097(선생님 결정 2026-08-26) — v2.3 확정가=공급가, 청구는 VAT 가산액. 개당
    # 가산 後 quantity를 곱한다(가산 後 합산이 아니라) — _packs_reserved_this_period의
    # 역산(총액÷개당가)이 임의 quantity에서 반올림 잔차 없이 정확히 나누어떨어지도록
    # 하는 유일하게 안전한 순서(합산 後 가산은 나눗셈 역산 시 큰 quantity에서 드리프트
    # 위험 — apply_vat_minor 독스트링 옆 계산 참고).
    taxed_price_minor = apply_vat_minor(price_minor, settings.vat_rate_bp)
    max_packs = pack.get("max_packs")
    if max_packs is not None:
        if sub.current_period_start is None or sub.current_period_end is None:
            raise PackPurchaseError(f"org_id={org_id}의 current_period가 세팅되지 않아 max_packs 판정 불가")

        # ⭐카디르 결함사냥 fix(#2891, 2026-08-07) — org+resource 스코프 advisory xact
        # lock으로 "카운트→판정" 구간을 직렬화한다. charge_org가 내부에서 자체 commit을
        # 여러 번 하므로(원자적 claim 커밋 → Toss 왕복 → confirm 커밋) 이 락은 charge_org
        # 호출 前까지만 유효 — 그래도 충분한 이유: charge_org의 첫 커밋(claim)이 곧
        # billing_orders에 이 구매를 "reserved"로 만드는 순간이고, _packs_reserved_
        # this_period가 pending도 세므로 그 커밋 직후부터 다음 락 획득자에게 정확히
        # 보인다 — claim 커밋이 락 해제와 사실상 동시에 일어나는 게 의도된 설계.
        await session.execute(
            select(func.pg_advisory_xact_lock(func.hashtext(f"pack_purchase_cap:{org_id}:{resource}")))
        )

        already = await _packs_reserved_this_period(
            session, org_id=org_id, resource=resource, taxed_price_minor=taxed_price_minor,
            period_start=sub.current_period_start, period_end=sub.current_period_end,
        )
        if already + quantity > max_packs:
            # 커밋 없이 즉시 rollback — 락을 바로 해제(다음 대기자가 안 밀리게)하고 명시 실패.
            await session.rollback()
            raise PackPurchaseError(
                f"resource={resource!r} max_packs={max_packs} 초과 — 이번 주기 이미 {already}개 "
                f"예약/구매, {quantity}개 추가 요청"
            )

    amount_minor = taxed_price_minor * quantity
    order_id = _pack_order_id(org_id, resource, idempotency_key)

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
