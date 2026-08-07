"""#2502+#2506 real-DB — checkout_subscription 전체 상태기계를 실 org_billing_keys/
org_subscriptions/billing_orders/billing_ledger_entries 위에서 검증. TossAdapter의 HTTP
왕복(create_billing_key/charge)만 mock — 나머지(암호화·DB 쓰기·원장)는 전부 실제로 돈다.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid
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


@pytest.fixture(autouse=True)
def _crypto_key(monkeypatch):
    import app.core.config as config_module
    from app.services import billing_key_crypto

    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", "W3x6lXDky6UQE36FyRU_Snf9m7d73Aev59D4PvS4-N0=")
    billing_key_crypto._get_multi_fernet.cache_clear()
    yield
    billing_key_crypto._get_multi_fernet.cache_clear()


async def _seed_org_with_members(session, *, human_seats=5):
    org_id = uuid.uuid4()
    for _ in range(human_seats):
        await session.execute(
            text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :uid, 'member')"),
            {"id": uuid.uuid4(), "org_id": org_id, "uid": uuid.uuid4()},
        )
    await session.commit()
    return org_id


@pytest.mark.anyio
async def test_checkout_full_flow_activates_subscription_and_writes_ledger_realdb():
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_members(session, human_seats=5)  # team 포함좌석과 동일

            toss_billing_key_response = {
                "billingKey": "billing-key-plaintext-test",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {
                "paymentKey": f"pay-{uuid.uuid4()}",
                "orderId": "unused-here",
                "totalAmount": 59_000,
            }

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )

            assert sub.status == "active"
            assert sub.tier == "team"
            assert sub.billing_cycle == "monthly"
            assert sub.current_period_start is not None
            assert sub.current_period_end is not None

            # org_billing_keys에 암호화된 빌링키가 실제로 저장됐는지.
            row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row is not None
            assert row.status == "active"
            assert row.encrypted_billing_key != "billing-key-plaintext-test"  # 평문 아님

            # billing_orders가 confirmed로 남았는지.
            order_row = (
                await session.execute(
                    text("SELECT status, amount_minor, payment_key FROM billing_orders WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert order_row.status == "confirmed"
            assert order_row.amount_minor == 59_000

            # 원장(A2)에 charge 엔트리가 실제로 기입됐는지.
            ledger_row = (
                await session.execute(
                    text("SELECT entry_type, amount_minor, direction FROM billing_ledger_entries WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert ledger_row.entry_type == "charge"
            assert ledger_row.amount_minor == 59_000
            assert ledger_row.direction == "credit"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_retry_same_day_does_not_double_charge_realdb():
    """더블클릭/네트워크 재시도 시나리오 — 같은 날 두 번째 checkout 호출도 같은
    orderId로 수렴해(#2493 원자적 claim) 원장에 charge 엔트리가 1건만 남아야 한다."""
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_members(session, human_seats=5)

            toss_billing_key_response = {
                "billingKey": "billing-key-plaintext-test-2",
                "card": {"issuerCode": "61", "acquirerCode": "31", "number": "12345678****000*", "cardType": "신용", "ownerType": "개인"},
                "authenticatedAt": "2026-08-07T00:00:00+09:00",
            }
            toss_charge_response = {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 59_000}

            # 1차 호출 — 정상 완료.
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response, toss_charge_response]
            )):
                sub1 = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )
            assert sub1.status == "active"

            # 2차 호출(더블클릭 재시도 가정) — billing key는 기존 customer_key 재사용,
            # charge는 같은 orderId라 charge_org가 기존 confirmed order를 그대로 반환
            # (Toss _post가 다시 호출되지 않아야 함 — side_effect 리스트에 charge용
            # 응답을 안 넣어서, 만약 다시 호출되면 StopIteration으로 즉시 실패한다).
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=[toss_billing_key_response]
            )):
                sub2 = await checkout_subscription(
                    session, org_id=org_id, auth_key="test-auth-key", tier="team", billing_cycle="monthly",
                )
            assert sub2.status == "active"

            ledger_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='charge'"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert ledger_count == 1  # 이중청구 안 됨
    finally:
        await engine.dispose()
