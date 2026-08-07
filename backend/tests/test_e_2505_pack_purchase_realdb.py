"""#2505 real-DB — purchase_packs 전체 흐름을 실 org_subscriptions/org_billing_keys/
billing_orders/billing_ledger_entries + 실 seed된 starter offering(au max_packs=5,
price_minor=5000) 위에서 검증. TossAdapter의 HTTP 왕복(charge)만 mock.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import asyncio
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


async def _seed_active_starter_org(session):
    from app.services.billing_key_crypto import encrypt_billing_key

    org_id = uuid.uuid4()
    offering_id = (
        await session.execute(
            text("SELECT id FROM offering_versions WHERE tier='starter' AND version_label='krw_v1'"),
        )
    ).scalar_one()
    await session.execute(
        text(
            "INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, currency, "
            "provider, offering_version_id, current_period_start, current_period_end) VALUES "
            "(:id, :org_id, 'starter', 'monthly', 'active', 'krw', 'toss', :offering_id, "
            "now() - interval '1 day', now() + interval '29 days')"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "offering_id": offering_id},
    )
    await session.execute(
        text(
            "INSERT INTO org_billing_keys (id, org_id, customer_key, encrypted_billing_key, "
            "status, issued_at) VALUES (:id, :org_id, :ck, :enc, 'active', now())"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "ck": f"cust-{uuid.uuid4()}", "enc": encrypt_billing_key("plaintext-billing-key")},
    )
    await session.commit()
    return org_id


@pytest.mark.anyio
async def test_purchase_pack_confirms_and_writes_pack_purchase_ledger_realdb():
    from app.services.billing_pack import purchase_packs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_active_starter_org(session)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 10_000}
            )):
                order = await purchase_packs(
                    session, org_id=org_id, resource="au", quantity=2, idempotency_key="rd-1",
                )

            assert order.status == "confirmed"
            assert order.amount_minor == 10_000  # 5,000 * 2

            entry = (
                await session.execute(
                    text(
                        "SELECT entry_type, amount_minor, metadata FROM billing_ledger_entries "
                        "WHERE org_id=:oid AND entry_type='pack_purchase'"
                    ),
                    {"oid": org_id},
                )
            ).first()
            assert entry.entry_type == "pack_purchase"
            assert entry.amount_minor == 10_000
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_purchase_pack_enforces_max_packs_cap_realdb():
    """starter au max_packs=5 — 이미 4개(20,000원) 산 org가 2개(총 6개) 더 사려 하면 거부."""
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_active_starter_org(session)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 20_000}
            )):
                first = await purchase_packs(
                    session, org_id=org_id, resource="au", quantity=4, idempotency_key="rd-2a",
                )
            assert first.status == "confirmed"

            with pytest.raises(PackPurchaseError, match="max_packs"):
                await purchase_packs(
                    session, org_id=org_id, resource="au", quantity=2, idempotency_key="rd-2b",
                )

            # 거부된 시도는 원장에 아무것도 안 남겨야(4개어치 1건만 존재).
            count = (
                await session.execute(
                    text(
                        "SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid "
                        "AND entry_type='pack_purchase'"
                    ),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert count == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_purchase_pack_retry_same_idempotency_key_does_not_double_charge_realdb():
    from app.services.billing_pack import purchase_packs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_active_starter_org(session)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 5_000}
            )):
                o1 = await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="rd-3")

            # 재시도(같은 키) — Toss _post가 다시 호출되면 side_effect 없어 즉시 실패한다.
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock()) as mock_post:
                o2 = await purchase_packs(session, org_id=org_id, resource="au", quantity=1, idempotency_key="rd-3")

            assert o1.status == o2.status == "confirmed"
            mock_post.assert_not_awaited()

            count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM billing_ledger_entries WHERE org_id=:oid AND entry_type='pack_purchase'"),
                    {"oid": org_id},
                )
            ).scalar_one()
            assert count == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_purchase_pack_concurrent_requests_do_not_exceed_max_packs_realdb():
    """카디르 결함사냥 fix 검증(#2891, 2026-08-07) — 진짜 동시성 하네스. starter au
    max_packs=5, 이미 4개 구매된 org에 두 개의 «완전히 별개 세션/커넥션»이 동시에
    1개씩(서로 다른 idempotency_key — 정당한 별개 구매 의도) 구매를 시도한다.
    advisory xact lock이 없으면 둘 다 카운트 4를 보고 통과해 6개(캡 초과)가 될 수
    있었다 — 락이 있으면 하나만 성공(confirmed)하고 나머지 하나는 즉시 재조회로
    5를 보고 거부돼야 한다(총 5개, 캡 준수)."""
    from app.services.billing_pack import PackPurchaseError, purchase_packs

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as seed_session:
            org_id = await _seed_active_starter_org(seed_session)
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 20_000}
            )):
                first = await purchase_packs(
                    seed_session, org_id=org_id, resource="au", quantity=4, idempotency_key="rd-4-seed",
                )
            assert first.status == "confirmed"

        # 두 개의 독립된 세션(=독립된 커넥션)으로 «진짜» 동시 요청을 흉내낸다.
        engine_a = create_async_engine(_ASYNC)
        engine_b = create_async_engine(_ASYNC)
        Session_a = async_sessionmaker(engine_a, expire_on_commit=False)
        Session_b = async_sessionmaker(engine_b, expire_on_commit=False)

        async def _attempt(session_factory, idempotency_key):
            async with session_factory() as session:
                try:
                    order = await purchase_packs(
                        session, org_id=org_id, resource="au", quantity=1, idempotency_key=idempotency_key,
                    )
                    return ("ok", order.status)
                except PackPurchaseError as exc:
                    return ("rejected", str(exc))

        with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
            side_effect=lambda *a, **kw: {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 5_000}
        )):
            results = await asyncio.gather(
                _attempt(Session_a, "rd-4-concurrent-a"),
                _attempt(Session_b, "rd-4-concurrent-b"),
            )

        await engine_a.dispose()
        await engine_b.dispose()

        outcomes = [r[0] for r in results]
        assert outcomes.count("ok") == 1, f"정확히 1건만 성공해야 하는데: {results}"
        assert outcomes.count("rejected") == 1, f"정확히 1건은 캡 초과로 거부돼야 하는데: {results}"

        async with Session() as verify_session:
            total_packs_amount = (
                await verify_session.execute(
                    text(
                        "SELECT COALESCE(SUM(amount_minor), 0) FROM billing_orders "
                        "WHERE order_id LIKE :prefix AND status = 'confirmed'"
                    ),
                    {"prefix": f"pack:{org_id}:au:%"},
                )
            ).scalar_one()
            assert total_packs_amount == 25_000  # 5개 * 5,000 — 6개(30,000)로 안 샘
    finally:
        await engine.dispose()
