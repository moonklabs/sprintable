"""story #2880(결제 트랙 갭①) — 월납 유료→유료 상향 엔진 실PG 검증. `test_e_2506_
subscription_checkout_realdb.py`와 동형(TossAdapter._post만 mock, 나머지는 실 DB) — 이
파일은 기존 active billing_key + active 유료 구독 + 직전 confirmed billing_order를
직접 seed해(checkout을 거치지 않고) change_tier() 자체를 검증한다.

**산식**(선생님 최종 확定, 2026-08-21): 신 offering 전액 즉시 청구(charge) → confirmed
後 tier+period 즉시 전이 → 직전 confirmed 결제 건에 잔여기간 일할 부분취소(refund).

커버:
  AC①: 신 offering 전액(좌석초과 포함) 청구 — delta 아님.
  AC②: 부분취소가 직전 confirmed order의 payment_key로 floor(구 월요금×잔여일/전체일)
       cancelAmount 부분취소를 정확히 태우는지(TossAdapter._post 2회 호출 — charge 1
       cancel 1, 순서까지 확認).
  AC③: period 리셋 — current_period_start=업그레이드 시각, current_period_end=+1개월.
  AC④: 신규 charge confirmed 前 실패 시 tier/period 원본 유지. 부분취소 실패는 신규
       charge를 되돌리지 않고 billing_orders.refund_status='failed'만 남긴다.
  AC⑤: annual/하향/동일가/미활성 구독은 TierChangeError(400 매핑 대상).
  ⓐ: 동시 두 change-tier 호출 중 하나만 성공(claim).
"""
from __future__ import annotations

import math
import os
import uuid
from datetime import datetime, timedelta, timezone
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


async def _seed_org(session):
    org_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.commit()
    return org_id


async def _offering(session, tier):
    row = (
        await session.execute(
            text("SELECT id, monthly_price_minor FROM offering_versions WHERE tier=:t AND currency='krw' AND effective_to IS NULL"),
            {"t": tier},
        )
    ).first()
    assert row is not None, f"offering_version(tier={tier!r}, krw) 시드 없음 — 0228 마이그 확認"
    return row.id, row.monthly_price_minor


async def _seed_active_paid_subscription(
    session, org_id, *, tier="starter", period_start=None, period_end=None,
):
    offering_id, _ = await _offering(session, tier)
    period_start = period_start or datetime.now(timezone.utc) - timedelta(days=10)
    period_end = period_end or period_start + timedelta(days=30)
    await session.execute(
        text(
            "INSERT INTO org_subscriptions "
            "(id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id, "
            " current_period_start, current_period_end) "
            "VALUES (:id, :org_id, :tier, 'monthly', 'active', 'krw', 'toss', :oid, :ps, :pe)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "tier": tier, "oid": offering_id, "ps": period_start, "pe": period_end},
    )
    await session.commit()
    return offering_id, period_start, period_end


async def _seed_active_billing_key(session, org_id):
    from app.services.billing_key_crypto import encrypt_billing_key

    await session.execute(
        text(
            "INSERT INTO org_billing_keys (id, org_id, customer_key, encrypted_billing_key, status, issued_at) "
            "VALUES (:id, :org_id, :ck, :ebk, 'active', now())"
        ),
        {
            "id": uuid.uuid4(), "org_id": org_id, "ck": f"org-{org_id}",
            "ebk": encrypt_billing_key("plaintext-billing-key-test"),
        },
    )
    await session.commit()


async def _seed_prior_confirmed_order(session, org_id, *, amount_minor):
    """직전 결제(원 tier 가입 시 charge)를 흉내 — 부분취소 대상."""
    order_id = f"prior-{uuid.uuid4()}"
    payment_key = f"pay-prior-{uuid.uuid4()}"
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, payment_key) "
            "VALUES (:id, :org_id, :oid, :amt, 'krw', 'confirmed', :pk)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "oid": order_id, "amt": amount_minor, "pk": payment_key},
    )
    await session.commit()
    return order_id, payment_key


def _toss_cancel_response(cancel_amount):
    return {
        "cancels": [{"transactionKey": f"txn-{uuid.uuid4()}", "cancelAmount": cancel_amount}],
    }


@pytest.mark.anyio
async def test_upgrade_charges_full_new_price_and_partial_refunds_prior_order_realdb():
    from app.services.org_subscription_tier_change import change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            # 30일 주기 중 정확히 10일 경과 → 잔여 20일(2/3).
            period_start = datetime.now(timezone.utc) - timedelta(days=10)
            period_end = period_start + timedelta(days=30)
            _, starter_price = await _offering(session, "starter")
            _, team_price = await _offering(session, "team")
            assert team_price > starter_price, "team이 starter보다 비싸야 이 테스트가 의미 있음"

            await _seed_active_paid_subscription(
                session, org_id, tier="starter", period_start=period_start, period_end=period_end,
            )
            await _seed_active_billing_key(session, org_id)
            prior_order_id, prior_payment_key = await _seed_prior_confirmed_order(session, org_id, amount_minor=starter_price)

            toss_charge_response = {"paymentKey": f"pay-new-{uuid.uuid4()}", "totalAmount": team_price}
            expected_refund_upper = math.floor(starter_price * (period_end - datetime.now(timezone.utc)).total_seconds() / (period_end - period_start).total_seconds())
            toss_cancel_response = _toss_cancel_response(expected_refund_upper)

            call_log = []

            async def _fake_post(self, path, **kwargs):
                call_log.append(path)
                if "cancel" in path:
                    return toss_cancel_response
                return toss_charge_response

            before_call = datetime.now(timezone.utc)
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                sub = await change_tier(session, org_id=org_id, new_tier="team")
            after_call = datetime.now(timezone.utc)

            # AC① — 신 offering 전액 청구(delta 아님).
            new_order_row = (
                await session.execute(
                    text("SELECT status, amount_minor FROM billing_orders WHERE org_id=:oid AND amount_minor=:amt AND order_id != :prior"),
                    {"oid": org_id, "amt": team_price, "prior": prior_order_id},
                )
            ).first()
            assert new_order_row is not None, "신 offering 전액(team_price) 청구 row가 없음"
            assert new_order_row.status == "confirmed"

            # AC③ — period 리셋.
            assert sub.tier == "team"
            assert before_call <= sub.current_period_start <= after_call
            assert sub.current_period_end > sub.current_period_start + timedelta(days=29)

            # AC② — 부분취소가 직전 order를 정확히 태움 + charge가 cancel보다 먼저 호출됨.
            cancel_calls = [c for c in call_log if "cancel" in c]
            assert len(cancel_calls) == 1
            assert prior_payment_key in cancel_calls[0]
            charge_idx = next(i for i, c in enumerate(call_log) if "billing/" in c and "cancel" not in c)
            cancel_idx = next(i for i, c in enumerate(call_log) if "cancel" in c)
            assert charge_idx < cancel_idx, "charge가 cancel보다 먼저 호출돼야 함(④ 시퀀싱)"

            prior_row = (
                await session.execute(
                    text("SELECT refund_status FROM billing_orders WHERE order_id=:oid"), {"oid": prior_order_id},
                )
            ).first()
            assert prior_row.refund_status == "confirmed"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upgrade_charge_declined_keeps_original_tier_and_period_realdb():
    """AC④ — 신규 전액 charge가 카드 거절되면 tier/period 그대로여야 한다(부분취소는
    애초에 시도되지 않아야 함 — Toss._post가 charge용 1회만 호출되고 그 뒤로 안 불림)."""
    from app.services.org_subscription_tier_change import TierChangeDeclined, change_tier
    from app.services.payment.toss_adapter import TossApiError

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            _, period_start, period_end = await _seed_active_paid_subscription(session, org_id, tier="starter")
            await _seed_active_billing_key(session, org_id)
            prior_order_id, _ = await _seed_prior_confirmed_order(session, org_id, amount_minor=1000)

            async def _raise_declined(*args, **kwargs):
                raise TossApiError("CARD_DECLINED", "카드 거절", status_code=400)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_raise_declined):
                with pytest.raises(TierChangeDeclined) as exc_info:
                    await change_tier(session, org_id=org_id, new_tier="team")
                assert exc_info.value.subscription.tier == "starter"

            row = (
                await session.execute(
                    text("SELECT tier, current_period_start, current_period_end, checkout_claimed_at FROM org_subscriptions WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.tier == "starter"
            assert row.current_period_start == period_start
            assert row.current_period_end == period_end
            assert row.checkout_claimed_at is None  # claim 해제(finally)

            # 부분취소가 시도조차 안 됐어야 함 — refund_status는 seed 시점 NULL 그대로.
            prior_row = (
                await session.execute(text("SELECT refund_status FROM billing_orders WHERE order_id=:oid"), {"oid": prior_order_id})
            ).first()
            assert prior_row.refund_status is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_refund_failure_does_not_roll_back_confirmed_charge_realdb():
    """AC④ 핵심 — 신규 charge는 confirmed됐는데 부분취소가 실패하면: tier/period는 그대로
    반영돼 있고(되돌리지 않음), 직전 order.refund_status='failed'만 남는다."""
    from app.services.org_subscription_tier_change import change_tier
    from app.services.payment.toss_adapter import TossApiError

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            _, starter_price = await _offering(session, "starter")
            await _seed_active_paid_subscription(session, org_id, tier="starter")
            await _seed_active_billing_key(session, org_id)
            prior_order_id, _ = await _seed_prior_confirmed_order(session, org_id, amount_minor=starter_price)

            _, team_price = await _offering(session, "team")
            toss_charge_response = {"paymentKey": f"pay-new-{uuid.uuid4()}", "totalAmount": team_price}

            async def _fake_post(self, path, **kwargs):
                if "cancel" in path:
                    raise TossApiError("INTERNAL_SERVER_ERROR", "일시 장애", status_code=500)
                return toss_charge_response

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                sub = await change_tier(session, org_id=org_id, new_tier="team")

            # 신규 charge는 confirmed로 살아있고 tier도 이미 team — 되돌리지 않음.
            assert sub.tier == "team"
            new_order_row = (
                await session.execute(
                    text("SELECT status FROM billing_orders WHERE org_id=:oid AND order_id != :prior"),
                    {"oid": org_id, "prior": prior_order_id},
                )
            ).first()
            assert new_order_row.status == "confirmed"

            prior_row = (
                await session.execute(text("SELECT refund_status FROM billing_orders WHERE order_id=:oid"), {"oid": prior_order_id})
            ).first()
            assert prior_row.refund_status == "failed"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_annual_billing_cycle_rejected_realdb():
    """AC⑤ — 연납 중 상향은 이 스토리 범위 밖(공식 문서 확定 선행), TierChangeError."""
    from app.services.org_subscription_tier_change import TierChangeError, change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            offering_id, _ = await _offering(session, "starter")
            await session.execute(
                text(
                    "INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id) "
                    "VALUES (:id, :org_id, 'starter', 'annual', 'active', 'krw', 'toss', :oid)"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "oid": offering_id},
            )
            await session.commit()

            with pytest.raises(TierChangeError, match="annual|연납"):
                await change_tier(session, org_id=org_id, new_tier="team")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_downgrade_direction_rejected_realdb():
    """AC⑤+ⓓ — team→starter(하향)는 이 엔진이 아니라 story #2881 몫, TierChangeError."""
    from app.services.org_subscription_tier_change import TierChangeError, change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="team")
            await _seed_active_billing_key(session, org_id)

            with pytest.raises(TierChangeError, match="상향이 아님"):
                await change_tier(session, org_id=org_id, new_tier="starter")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_same_tier_rejected_realdb():
    """AC⑤+ⓓ — 동일 tier 재제출도 상향이 아님."""
    from app.services.org_subscription_tier_change import TierChangeError, change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="team")
            await _seed_active_billing_key(session, org_id)

            with pytest.raises(TierChangeError, match="상향이 아님"):
                await change_tier(session, org_id=org_id, new_tier="team")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_change_tier_calls_only_one_succeeds_realdb():
    """ⓐ — 동시 두 change-tier 호출(이중 클릭 가정) 중 정확히 하나만 claim에 성공,
    나머지는 TierChangeInProgress(409 매핑 대상)."""
    import asyncio

    from app.services.org_subscription_tier_change import TierChangeInProgress, change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as setup_session:
            org_id = await _seed_org(setup_session)
            await _seed_active_paid_subscription(setup_session, org_id, tier="starter")
            await _seed_active_billing_key(setup_session, org_id)

        async def _attempt():
            async with Session() as s:
                async def _fake_post(self, path, **kwargs):
                    if "cancel" in path:
                        return _toss_cancel_response(0)
                    return {"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": 0}

                with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                    return await change_tier(s, org_id=org_id, new_tier="team")

        results = await asyncio.gather(_attempt(), _attempt(), return_exceptions=True)
        succeeded = [r for r in results if not isinstance(r, Exception)]
        in_progress = [r for r in results if isinstance(r, TierChangeInProgress)]
        assert len(succeeded) == 1, f"정확히 하나만 성공해야 함: {results}"
        assert len(in_progress) == 1, f"나머지 하나는 TierChangeInProgress여야 함: {results}"
    finally:
        await engine.dispose()
