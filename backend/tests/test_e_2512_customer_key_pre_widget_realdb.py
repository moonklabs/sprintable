"""#2512 real-DB — customerKey 사전발급→체크아웃 전체 흐름을 실 org_billing_keys +
org_subscriptions 위에서 검증. TossAdapter의 HTTP 왕복만 mock.

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


@pytest.mark.anyio
async def test_ensure_customer_key_then_checkout_reuses_placeholder_realdb():
    """FE 실 플로우 재현: ①customerKey 사전발급(위젯 열기 前) ②위젯 인증 완료 후
    checkout(authKey) 호출 — 같은 customer_key가 그대로 쓰이고 placeholder가 실 빌링키로
    덮어써지는지, 그리고 checkout이 정상적으로 active까지 도달하는지 실PG로 확認."""
    from app.services.org_billing_key import ensure_customer_key
    from app.services.org_subscription_checkout import checkout_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            for _ in range(3):  # starter included_seats=3 — 초과 없이
                await session.execute(
                    text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :oid, :uid, 'member')"),
                    {"id": uuid.uuid4(), "oid": org_id, "uid": uuid.uuid4()},
                )
            await session.commit()

            # ① 위젯 열기 前 — customerKey 사전발급.
            pre_widget_key = await ensure_customer_key(session, org_id=org_id)
            assert pre_widget_key.startswith("org-")

            row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key, customer_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.status == "awaiting_auth"
            assert row.encrypted_billing_key is None
            assert row.customer_key == pre_widget_key

            # ② 위젯 인증 완료 → checkout(authKey) — 같은 customer_key로 Toss 호출돼야.
            captured_customer_keys = []

            async def _fake_post(self, path, *, json, timeout, op_label, idempotency_key=None):
                if op_label == "billing key issuance":
                    captured_customer_keys.append(json["customerKey"])
                    return {
                        "billingKey": "real-billing-key",
                        "card": {"issuerCode": "61", "number": "1234****", "cardType": "신용", "ownerType": "개인"},
                        "authenticatedAt": "2026-08-07T00:00:00+09:00",
                    }
                return {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 29_000}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                sub = await checkout_subscription(
                    session, org_id=org_id, auth_key="widget-auth-key", tier="starter", billing_cycle="monthly",
                )

            assert sub.status == "active"
            assert captured_customer_keys == [pre_widget_key]  # placeholder의 customer_key 재사용됨

            final_row = (
                await session.execute(
                    text("SELECT status, encrypted_billing_key, customer_key FROM org_billing_keys WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert final_row.status == "active"
            assert final_row.encrypted_billing_key is not None  # placeholder가 실 빌링키로 덮어써짐
            assert final_row.customer_key == pre_widget_key  # customer_key는 그대로
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_customer_key_is_idempotent_across_calls_realdb():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            from app.services.org_billing_key import ensure_customer_key

            org_id = uuid.uuid4()
            key1 = await ensure_customer_key(session, org_id=org_id)
            key2 = await ensure_customer_key(session, org_id=org_id)
            assert key1 == key2

            count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM org_billing_keys WHERE org_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            assert count == 1  # 두 번 불러도 1행만
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_awaiting_auth_placeholder_is_never_treated_as_active_billing_key_realdb():
    """PO/카디르 결함사냥 축② 사전 pin — awaiting_auth placeholder(위젯 인증 前, 실
    빌링키 없음)를 charge_org가 "활성 빌링키"로 오인해 청구를 시도하면 안 된다.
    org_subscription이 active라도(예: 과거 다른 경로로 active가 됐거나 테스트 조작)
    billing_key가 없으면 명시 실패해야지, 조용히 청구가 나가면 안 된다."""
    from app.services.billing_charge import charge_org
    from app.services.org_billing_key import ensure_customer_key

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            # placeholder만 있고(실 빌링키 없음) — 위젯 인증 前 상태 그대로.
            await ensure_customer_key(session, org_id=org_id)

            row = (
                await session.execute(
                    text("SELECT status FROM org_billing_keys WHERE org_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row.status == "awaiting_auth"

            with pytest.raises(RuntimeError, match="no active billing key"):
                await charge_org(
                    session, org_id=org_id, order_id=f"test-{uuid.uuid4()}",
                    amount_minor=59_000, currency="krw",
                )
    finally:
        await engine.dispose()
