"""[SID:4755] A charge that was confirmed for an organization that is closed by the time it settles goes back to the customer — and a person is told.

The scheduler charges first (the provider call cannot be made while holding the organization row lock: it takes up to 65 s) and writes the subscription after. An organization that was closed
in between holds the lock the scheduler then waits for, and is gone when it gets it — the confirmed charge has nowhere to go. It is refunded in full (`refund_org`, idempotency key
`orgclosed-refund:<order_id>`: calling it again after a failure or a success never refunds twice), the order says so (`billing_orders.refund_status` = confirmed / failed — the column
the tier-change partial refund already uses), and the platform's operator alert (`services/operator_alerts.py`, story 4341) tells people: `billing.charge_refunded_org_closed` when it went back,
`billing.charge_refund_failed_org_closed` when it did not (the order is then `refund_status = 'failed'` and the next dunning sweep retries it with the same key)."""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.services.billing_refund import refund_org

logger = logging.getLogger(__name__)

CANCEL_REASON = "organization closed while the charge was settling"
RETRY_BATCH = 20


def refund_idempotency_key(order_id: str) -> str:
    return f"orgclosed-refund:{order_id}"


async def refund_charge_for_closed_org(session: AsyncSession, *, org_id: uuid.UUID, order_id: str) -> bool:
    """True when the order is (now or already) refunded. Never raises for a failed refund — it records `refund_status = 'failed'`, alerts, and returns False."""
    order = (await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id).execution_options(populate_existing=True))).scalar_one_or_none()
    if order is None or order.org_id != org_id:
        logger.error("billing.closed_org_refund: no order %s of org %s to refund", order_id, org_id)
        return False
    if order.refund_status == "confirmed":
        return True                                           # already refunded — never a second refund
    amount_minor, currency = order.amount_minor, order.currency   # read now: a rollback below expires the loaded row
    try:
        await refund_org(session, org_id=org_id, order_id=order_id, cancel_reason=CANCEL_REASON, idempotency_key=refund_idempotency_key(order_id))
    except Exception as exc:
        await session.rollback()
        logger.error("billing.closed_org_refund FAILED org=%s order=%s: %s", org_id, order_id, exc, exc_info=True)
        await session.execute(text("UPDATE billing_orders SET refund_status = 'failed', updated_at = now() WHERE order_id = :o AND refund_status IS DISTINCT FROM 'confirmed'"), {"o": order_id})
        await session.commit()
        await _alert("billing.charge_refund_failed_org_closed", "CHARGE_REFUND_FAILED_ORG_CLOSED", org_id, order_id, amount_minor, currency)
        return False
    await session.execute(text("UPDATE billing_orders SET refund_status = 'confirmed', updated_at = now() WHERE order_id = :o"), {"o": order_id})
    await session.commit()
    await _alert("billing.charge_refunded_org_closed", "CHARGE_REFUNDED_ORG_CLOSED", org_id, order_id, amount_minor, currency)
    return True


async def retry_failed_closed_org_refunds(session: AsyncSession) -> int:
    """The next sweep takes up the refunds that failed before: confirmed charges whose organization is gone and whose `refund_status` says `failed` — same idempotency key."""
    rows = (await session.execute(text(
        "SELECT o.order_id, o.org_id FROM billing_orders o WHERE o.status = 'confirmed' AND o.refund_status = 'failed'"
        " AND NOT EXISTS (SELECT 1 FROM organizations g WHERE g.id = o.org_id) ORDER BY o.updated_at LIMIT :n"
    ), {"n": RETRY_BATCH})).all()
    done = 0
    for order_id, org_id in rows:
        if await refund_charge_for_closed_org(session, org_id=org_id, order_id=order_id):
            done += 1
    return done


async def _alert(kind: str, code: str, org_id: uuid.UUID, order_id: str, amount_minor: int, currency: str) -> None:
    try:
        from app.services.operator_alerts import notify_operator

        await notify_operator(
            kind=kind, dedupe_key=f"{kind}:{order_id}", target_org_id=org_id, target={"org_id": org_id},
            facts={"code": code, "amount_minor": amount_minor, "currency": str(currency).upper()},
        )
    except Exception:
        logger.exception("%s: operator alert failed org=%s order=%s", kind, org_id, order_id)
