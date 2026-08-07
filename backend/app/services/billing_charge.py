"""결제②-C2(story #2493) — charge 오케스트레이션: orderId-먼저-기록 → TossAdapter.charge →
billing_ledger_entries 원장 기입. PO 계약(2026-08-07, `toss-adapter-c-plan-v0-1` §8 C2):
**메커니즘만** — amount/currency/order_id는 파라미터로 받는다(「얼마 청구할지」 계산은
별도 pricing-calc 스토리, offering_version×좌석×팩이 아직 배선 안 됨).
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.billing_order import BillingOrder
from app.models.org_billing_key import OrgBillingKey
from app.services.billing_key_crypto import decrypt_billing_key, ensure_configured
from app.services.billing_ledger import record_ledger_entry
from app.services.payment.toss_adapter import TossAdapter


async def charge_org(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    order_id: str,
    amount_minor: int,
    currency: str,
    order_name: str = "Sprintable 정기결제",
) -> BillingOrder:
    """org의 활성 빌링키로 결제를 승인한다. 호출자(story C3 스케줄러)가 amount/currency/
    order_id를 이미 계산해 넘긴다 — 여기는 그 값을 안전하게 집행하는 메커니즘만 진다.

    같은 order_id로 재호출 시(재시도) — 이미 confirmed면 Toss를 다시 안 부르고 그대로
    반환한다(진짜 멱등, ledger provider_ref UNIQUE와 동일 정신). pending/failed였던 order는
    재시도로 다시 charge를 시도한다."""
    if amount_minor <= 0:
        raise ValueError(f"amount_minor must be positive: {amount_minor!r}")

    existing = (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one_or_none()
    if existing is not None and existing.status == "confirmed":
        return existing

    # PO nit①과 동일 규율(C1 리뷰, #2880) — 되돌릴 수 없는 Toss charge 前에 암호화 키
    # 가용성부터 확認. 여기선 charge 자체가 그 "되돌릴 수 없는 호출"이다.
    ensure_configured()

    billing_key_row = (
        await session.execute(
            select(OrgBillingKey).where(
                OrgBillingKey.org_id == org_id, OrgBillingKey.status == "active"
            )
        )
    ).scalar_one_or_none()
    if billing_key_row is None:
        raise RuntimeError(f"no active billing key for org {org_id}")

    # ⭐orderId-먼저-기록 — Toss 호출 前에 pending으로 기록해 크래시/타임아웃(최대 60초)도
    # 복구 가능하게 한다. amount/currency는 최초 기록 값을 정본으로 유지(재시도 시 덮어쓰지
    # 않음 — 같은 order_id로 다른 금액이 들어오면 그건 호출자 버그이지 이 함수가 침묵하고
    # 받아줄 자리가 아니다).
    stmt = pg_insert(BillingOrder).values(
        id=uuid.uuid4(), org_id=org_id, order_id=order_id,
        amount_minor=amount_minor, currency=currency, status="pending",
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["order_id"], set_={"status": "pending", "updated_at": func.now()},
    )
    await session.execute(stmt)
    await session.commit()

    billing_key_plaintext = decrypt_billing_key(billing_key_row.encrypted_billing_key)
    try:
        result = await TossAdapter().charge(
            billing_key=billing_key_plaintext,
            customer_key=billing_key_row.customer_key,
            order_id=order_id,
            amount_minor=amount_minor,
            order_name=order_name,
        )
    except RuntimeError as exc:
        await session.execute(
            update(BillingOrder)
            .where(BillingOrder.order_id == order_id)
            .values(status="failed", failure_reason=str(exc)[:500], updated_at=func.now())
        )
        await session.commit()
        raise
    finally:
        # ⛔PO guard② — 평문 스코프 최소화(best-effort, 이 함수 프레임을 벗어나지 않는다).
        billing_key_plaintext = None  # noqa: F841

    payment_key = result["paymentKey"]
    await session.execute(
        update(BillingOrder)
        .where(BillingOrder.order_id == order_id)
        .values(status="confirmed", payment_key=payment_key, updated_at=func.now())
    )
    await session.commit()

    # A2 원장 — 여기가 첫 실 producer(provider_ref=paymentKey UNIQUE가 이중 안전망).
    await record_ledger_entry(
        session,
        org_id=org_id,
        entry_type="charge",
        amount_minor=amount_minor,
        currency=currency,
        direction="credit",
        provider="toss",
        provider_ref=payment_key,
    )

    return (
        await session.execute(select(BillingOrder).where(BillingOrder.order_id == order_id))
    ).scalar_one()
