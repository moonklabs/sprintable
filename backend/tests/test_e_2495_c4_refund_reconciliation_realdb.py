"""#2495(C4) real-DB — refund_org/mark_billing_key_deleted가 실 billing_orders/
org_billing_keys/billing_ledger_entries 위에서 정확히 도는지 증명(Toss HTTP 왕복만 mock).

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed_confirmed_order(session, *, amount_minor=59_000, currency="krw"):
    org_id = uuid.uuid4()
    order_id = f"ord-{uuid.uuid4()}"
    payment_key = f"pay-{uuid.uuid4()}"
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, "
            "payment_key) VALUES (:id, :org_id, :order_id, :amount, :cur, 'confirmed', :pk)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "order_id": order_id, "amount": amount_minor,
         "cur": currency, "pk": payment_key},
    )
    await session.commit()
    return org_id, order_id


@pytest.mark.anyio
async def test_refund_org_writes_real_ledger_entry_and_is_idempotent_on_retry():
    from app.services.billing_refund import refund_org

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, order_id = await _seed_confirmed_order(session, amount_minor=59_000)

            toss_response = {"cancels": [{"transactionKey": f"tx-{uuid.uuid4()}", "cancelAmount": 59_000}]}
            with patch("app.services.billing_refund.TossAdapter") as MockAdapter:
                MockAdapter.return_value.refund = AsyncMock(return_value=toss_response)
                entry1 = await refund_org(session, org_id=org_id, order_id=order_id, cancel_reason="테스트 환불")
                # 재시도(같은 Toss 응답 재수신 가정) — provider_ref UNIQUE로 멱등, 새 행 안 생김.
                entry2 = await refund_org(session, org_id=org_id, order_id=order_id, cancel_reason="테스트 환불")

            assert entry1.id == entry2.id
            assert entry1.entry_type == "refund"
            assert entry1.direction == "debit"
            assert entry1.amount_minor == 59_000

            count_row = (
                await session.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert count_row == 1  # 두 번 불러도 원장엔 1건만(멱등 실증)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mark_billing_key_deleted_real_update_and_reapply_is_safe():
    from app.services.org_billing_key import mark_billing_key_deleted

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            customer_key = f"cust-{uuid.uuid4()}"
            await session.execute(
                text(
                    "INSERT INTO org_billing_keys (id, org_id, customer_key, encrypted_billing_key, "
                    "status, issued_at) VALUES (:id, :org_id, :ck, 'enc-placeholder', 'active', now())"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "ck": customer_key},
            )
            await session.commit()

            await mark_billing_key_deleted(session, customer_key=customer_key)
            # 재생(웹훅 재전송 가정) — 재적용해도 안전(멱등 UPDATE, 크래시 없음).
            await mark_billing_key_deleted(session, customer_key=customer_key)

            status = (
                await session.execute(
                    text("SELECT status FROM org_billing_keys WHERE customer_key=:ck"),
                    {"ck": customer_key},
                )
            ).scalar_one()
            assert status == "deleted"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconciliation_adjustment_entry_persists_real_row():
    from app.services.billing_reconciliation import daily_reconcile_confirmed_orders

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id, order_id = await _seed_confirmed_order(session, amount_minor=59_000)

            with patch("app.services.billing_reconciliation.TossAdapter") as MockAdapter:
                MockAdapter.return_value.get_payment_by_order_id = AsyncMock(
                    return_value={"status": "DONE", "totalAmount": 49_000}
                )
                result = await daily_reconcile_confirmed_orders(session, now=datetime.now(timezone.utc))

            # 다른 테스트가 같은 lookback 창에 만든 confirmed order도 이 배치가 함께
            # 스캔한다(글로벌 잡이라 의도된 동작) — 그래서 정확히 1건이 아니라 "적어도
            # 이 order 몫 1건"만 단정하고, 실 증거는 아래 이 org_id 스코프 원장 조회로.
            assert result["mismatched"] >= 1

            entry = (
                await session.execute(
                    text(
                        "SELECT entry_type, amount_minor, direction FROM billing_ledger_entries "
                        "WHERE org_id=:oid AND entry_type='adjustment'"
                    ),
                    {"oid": org_id},
                )
            ).first()
            assert entry is not None
            assert entry.amount_minor == 10_000
            assert entry.direction == "debit"
    finally:
        await engine.dispose()
