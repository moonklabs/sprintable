"""결제②-C4(story #2495) — 일일 대사(reconciliation) 배치. C3(#2494)의
sweep_stale_pending_orders가 「pending으로 너무 오래 멈춘」 축을 이미 대사하는 것과
짝 — 이 모듈은 「confirmed로 이미 닫힌」 order가 실제로 Toss와 금액이 맞는지 재확認하는
축이다(`toss-adapter-c-plan-v0-1` §2 step8).

불일치를 발견해도 자동으로 정정하지 않는다 — entry_type="adjustment" 원장 엔트리로
「사람이 봐야 하는 신호」만 남긴다(v2.1 원장 설계 원칙: 원장은 정본, 자동 수정은 없음)."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.services.billing_ledger import record_ledger_entry
from app.services.payment.toss_adapter import TossAdapter

logger = logging.getLogger(__name__)

# 너무 오래된 order까지 매일 재조회하지 않는다 — 대사는 "최근 확정분이 실제로 Toss와
# 맞는지"가 목적이지 전체 이력 감사가 아니다(그건 별도 축).
RECONCILIATION_LOOKBACK = timedelta(days=7)


async def daily_reconcile_confirmed_orders(session: AsyncSession, *, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cutoff = now - RECONCILIATION_LOOKBACK
    orders = (
        await session.execute(
            select(BillingOrder).where(
                BillingOrder.status == "confirmed",
                BillingOrder.created_at >= cutoff,
            )
        )
    ).scalars().all()

    matched = mismatched = skipped = 0
    for order in orders:
        try:
            lookup = await TossAdapter().get_payment_by_order_id(order_id=order.order_id)
        except Exception:
            # 조회 자체가 실패(네트워크 등)한 것 — 불일치라 단정 못 한다. 다음 날 재시도.
            logger.exception(
                "reconciliation lookup failed for order_id=%s — skipped this round", order.order_id
            )
            skipped += 1
            continue

        toss_amount = lookup.get("totalAmount") if lookup.get("status") == "DONE" else None
        if toss_amount == order.amount_minor:
            matched += 1
            continue

        mismatched += 1
        diff = (toss_amount or 0) - order.amount_minor
        # provider_ref에 날짜를 안 넣는다 — 같은 order의 같은 불일치가 다음 날 또
        # 재발견돼도(아직 검토/정정 안 됐다는 뜻) 매번 새 adjustment를 쌓아 잔액을
        # 이중으로 왜곡시키지 않기 위해서(첫 발견에만 1건, record_ledger_entry의
        # provider_ref UNIQUE가 그 뒤로는 멱등 no-op).
        await record_ledger_entry(
            session,
            org_id=order.org_id,
            entry_type="adjustment",
            amount_minor=abs(diff),
            currency=order.currency,
            direction="credit" if diff > 0 else "debit",
            provider="toss",
            provider_ref=f"reconciliation-adjustment:{order.order_id}",
            metadata={
                "reason": "daily_reconciliation_mismatch",
                "order_id": order.order_id,
                "internal_amount_minor": order.amount_minor,
                "toss_amount_minor": toss_amount,
                "toss_status": lookup.get("status"),
            },
        )

    return {
        "orders_checked": len(orders),
        "matched": matched,
        "mismatched": mismatched,
        "skipped_lookup_error": skipped,
    }
