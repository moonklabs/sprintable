"""결제②-C4(story #2495) — 환불 오케스트레이션. confirmed billing_orders(C2)의
payment_key로 Toss 취소 API를 부르고, 성공 응답을 record_ledger_entry(entry_type=
"refund")로 원장(A2)에 남긴다.

이중 멱등: TossAdapter.refund의 Idempotent-Key 헤더(order_id 결정적 파생 — 같은 order를
다시 부르면 Toss가 중복 취소를 안 만든다)가 1차, record_ledger_entry의 provider_ref
UNIQUE(transactionKey 기반)가 2차."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_ledger_entry import BillingLedgerEntry
from app.models.billing_order import BillingOrder
from app.services.billing_ledger import record_ledger_entry
from app.services.payment.toss_adapter import TossAdapter


class RefundError(Exception):
    """환불을 진행할 수 없는 상태 — 잘못된 대상에 조용히 진행하지 않고 명시 실패."""


async def refund_org(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    order_id: str,
    cancel_reason: str,
    cancel_amount_minor: int | None = None,
) -> BillingLedgerEntry:
    """order_id가 가리키는 confirmed 결제를 환불(전액 또는 cancel_amount_minor만큼
    부분)하고 원장 엔트리를 반환한다."""
    order = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one_or_none()
    if order is None:
        raise RefundError(f"no billing_order for order_id={order_id!r}")
    if order.org_id != org_id:
        raise RefundError(f"order_id={order_id!r} does not belong to org_id={org_id}")
    if order.status != "confirmed" or not order.payment_key:
        raise RefundError(
            f"order_id={order_id!r} is not a confirmed charge(status={order.status!r}) — nothing to refund"
        )
    if cancel_amount_minor is not None and cancel_amount_minor > order.amount_minor:
        raise RefundError(
            f"cancel_amount_minor={cancel_amount_minor} exceeds original charge "
            f"amount={order.amount_minor} for order_id={order_id!r}"
        )

    result = await TossAdapter().refund(
        payment_key=order.payment_key,
        cancel_reason=cancel_reason,
        cancel_amount_minor=cancel_amount_minor,
        idempotency_key=f"refund:{order_id}",
    )

    cancels = result.get("cancels") or []
    if not cancels:
        raise RefundError(f"Toss refund response missing cancels[] for order_id={order_id!r}")
    latest_cancel = cancels[-1]
    transaction_key = latest_cancel.get("transactionKey")
    refunded_amount = latest_cancel.get("cancelAmount")
    if not transaction_key or refunded_amount is None:
        raise RefundError(
            f"Toss refund response missing transactionKey/cancelAmount for order_id={order_id!r}"
        )

    return await record_ledger_entry(
        session,
        org_id=org_id,
        entry_type="refund",
        amount_minor=refunded_amount,
        currency=order.currency,
        direction="debit",
        provider="toss",
        provider_ref=transaction_key,
        metadata={"order_id": order_id, "cancel_reason": cancel_reason},
    )
