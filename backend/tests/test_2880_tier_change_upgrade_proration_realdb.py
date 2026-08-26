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


async def _vat_rate_bp(session):
    """story #3097 — 실 DB의 platform_settings.vat_rate_bp(마이그 0282 기본 1000=10%)."""
    row = (await session.execute(text("SELECT vat_rate_bp FROM platform_settings LIMIT 1"))).first()
    assert row is not None, "platform_settings 행 없음 — 0255/0282 마이그 확認"
    return row.vat_rate_bp


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


async def _seed_prior_confirmed_order(session, org_id, *, amount_minor, created_at=None):
    """직전 결제(원 tier 가입 시 charge)를 흉내 — 부분취소 대상. purpose는 컬럼
    server_default('charge')에 맡긴다(0268)."""
    order_id = f"prior-{uuid.uuid4()}"
    payment_key = f"pay-prior-{uuid.uuid4()}"
    created_at = created_at or datetime.now(timezone.utc)
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, payment_key, created_at) "
            "VALUES (:id, :org_id, :oid, :amt, 'krw', 'confirmed', :pk, :ca)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "oid": order_id, "amt": amount_minor, "pk": payment_key, "ca": created_at},
    )
    await session.commit()
    return order_id, payment_key


async def _seed_pack_purchase_order(session, org_id, *, amount_minor, created_at=None):
    """카디르 CRITICAL 재현용 — pack 구매도 같은 billing_orders 테이블에 confirmed row를
    남긴다(billing_pack.py::purchase_packs, charge_org(entry_type="pack_purchase"))."""
    order_id = f"pack-{uuid.uuid4()}"
    payment_key = f"pay-pack-{uuid.uuid4()}"
    created_at = created_at or datetime.now(timezone.utc)
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, payment_key, purpose, created_at) "
            "VALUES (:id, :org_id, :oid, :amt, 'krw', 'confirmed', :pk, 'pack_purchase', :ca)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "oid": order_id, "amt": amount_minor, "pk": payment_key, "ca": created_at},
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

            # story #3097(선생님 결정 2026-08-26) — v2.3 확정가=공급가, 청구/부분취소 둘 다
            # VAT 가산액 기준(compute_full_charge_for_new_offering·prorate_minor 호출부 fix).
            from app.services.billing_charge_amount import apply_vat_minor
            vat_rate_bp = await _vat_rate_bp(session)
            taxed_team_price = apply_vat_minor(team_price, vat_rate_bp)
            taxed_starter_price = apply_vat_minor(starter_price, vat_rate_bp)

            toss_charge_response = {"paymentKey": f"pay-new-{uuid.uuid4()}", "totalAmount": taxed_team_price}
            expected_refund_upper = math.floor(taxed_starter_price * (period_end - datetime.now(timezone.utc)).total_seconds() / (period_end - period_start).total_seconds())
            toss_cancel_response = _toss_cancel_response(expected_refund_upper)

            call_log = []
            cancel_bodies = []

            async def _fake_post(self, path, *, json, **kwargs):
                call_log.append(path)
                if "cancel" in path:
                    cancel_bodies.append(json)
                    return toss_cancel_response
                return toss_charge_response

            before_call = datetime.now(timezone.utc)
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                sub = await change_tier(session, org_id=org_id, new_tier="team")
            after_call = datetime.now(timezone.utc)

            # AC① — 신 offering 전액(VAT 가산) 청구(delta 아님).
            new_order_row = (
                await session.execute(
                    text("SELECT status, amount_minor FROM billing_orders WHERE org_id=:oid AND amount_minor=:amt AND order_id != :prior"),
                    {"oid": org_id, "amt": taxed_team_price, "prior": prior_order_id},
                )
            ).first()
            assert new_order_row is not None, "신 offering 전액(VAT 가산 team_price) 청구 row가 없음"
            assert new_order_row.status == "confirmed"

            # story #3097 — 부분취소 cancelAmount가 VAT 가산 구 요금 기준으로 일할됐는지 직접
            # 대조(원 공급가로 일할하면 환불액이 VAT분만큼 과소산정된다). prorate_minor의
            # 내부 now()는 [before_call, after_call] 구간 안에서 찍히므로(코드 진입이
            # before_call보다 늦고 반환이 after_call보다 이르다 — 정확한 스냅샷 시각을 몰라도
            # 그 구간의 상/하한으로 범위를 좁힐 수 있다), 그 구간 양끝으로 계산한 범위 안에
            # 실측값이 들어오는지로 검증한다(하드 동일값 비교는 ms 타이밍 레이스로 flaky).
            assert len(cancel_bodies) == 1
            lower_bound = math.floor(taxed_starter_price * (period_end - after_call).total_seconds() / (period_end - period_start).total_seconds())
            upper_bound = math.floor(taxed_starter_price * (period_end - before_call).total_seconds() / (period_end - period_start).total_seconds())
            assert lower_bound <= cancel_bodies[0]["cancelAmount"] <= upper_bound
            # VAT 미가산(구 코드 산식)이었다면 이 범위보다 명확히 작았을 것 — 실제로 가산됐음을
            # 방향성으로도 재확認.
            raw_upper_bound = math.floor(starter_price * (period_end - before_call).total_seconds() / (period_end - period_start).total_seconds())
            assert cancel_bodies[0]["cancelAmount"] > raw_upper_bound

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


# ─── 카디르 CRITICAL 재현 회귀(2026-08-21, PR#3306 리뷰) — pack구매 오인 부분취소 ───

@pytest.mark.anyio
async def test_partial_refund_targets_subscription_charge_not_more_recent_pack_purchase_realdb():
    """시나리오 A(카디르 재현①) — pack금액이 prorate액보다 작을 때. 정정 前엔
    `_latest_confirmed_order`가 더 최근인 pack 주문을 골라 refund_org 자체 방어
    (cancel_amount_minor exceeds original charge amount)로 막혀 refund_status='failed'만
    남고, 진짜 구독 결제는 영원히 미환급이었다. 정정 後엔 purpose='charge' 필터로
    구독 order를 정확히 골라 성공해야 한다."""
    from app.services.org_subscription_tier_change import change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_start = datetime.now(timezone.utc) - timedelta(days=10)
            period_end = period_start + timedelta(days=30)
            _, starter_price = await _offering(session, "starter")
            _, team_price = await _offering(session, "team")

            await _seed_active_paid_subscription(session, org_id, tier="starter", period_start=period_start, period_end=period_end)
            await _seed_active_billing_key(session, org_id)
            # 구독 charge(10일 전, starter_price) — 부분취소 진짜 대상.
            sub_order_id, sub_payment_key = await _seed_prior_confirmed_order(
                session, org_id, amount_minor=starter_price, created_at=period_start,
            )
            # pack 구매(1일 전, 구독 charge보다 최근이지만 소액) — 오인 대상이면 안 됨.
            pack_amount = 5_000
            await _seed_pack_purchase_order(
                session, org_id, amount_minor=pack_amount,
                created_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

            call_log = []

            async def _fake_post(self, path, **kwargs):
                call_log.append((path, kwargs.get("json")))
                if "cancel" in path:
                    return _toss_cancel_response(kwargs["json"]["cancelAmount"])
                return {"paymentKey": f"pay-new-{uuid.uuid4()}", "totalAmount": team_price}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                await change_tier(session, org_id=org_id, new_tier="team")

            cancel_calls = [c for c in call_log if "cancel" in c[0]]
            assert len(cancel_calls) == 1
            assert sub_payment_key in cancel_calls[0][0], "부분취소가 구독 order를 타겟해야 함(pack 아님)"

            sub_row = (
                await session.execute(text("SELECT refund_status FROM billing_orders WHERE order_id=:oid"), {"oid": sub_order_id})
            ).first()
            assert sub_row.refund_status == "confirmed"

            # pack 주문은 손대지 않았어야 함.
            pack_row = (
                await session.execute(text("SELECT refund_status FROM billing_orders WHERE purpose='pack_purchase' AND org_id=:oid"), {"oid": org_id})
            ).first()
            assert pack_row.refund_status is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_refund_does_not_silently_cancel_unrelated_pack_purchase_when_pack_amount_larger_realdb():
    """시나리오 B(카디르 재현②, 더 위험) — pack금액이 prorate액보다 클 때. 정정 前엔
    refund_org의 「초과 금액 방어」가 안 걸려(pack 주문 자체 금액이 충분히 커서)
    무관한 고객의 정상 pack 구매가 조용히 부분취소됐다(refund_status='confirmed'로
    기록되지만 targeted_pack=True, targeted_sub=False — 아무 에러도 없이 잘못된 돈이
    빠져나감). 정정 後엔 애초에 pack 주문이 후보에 들지 않아야 한다."""
    from app.services.org_subscription_tier_change import change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_start = datetime.now(timezone.utc) - timedelta(days=10)
            period_end = period_start + timedelta(days=30)
            _, starter_price = await _offering(session, "starter")
            _, team_price = await _offering(session, "team")

            await _seed_active_paid_subscription(session, org_id, tier="starter", period_start=period_start, period_end=period_end)
            await _seed_active_billing_key(session, org_id)
            sub_order_id, sub_payment_key = await _seed_prior_confirmed_order(
                session, org_id, amount_minor=starter_price, created_at=period_start,
            )
            # pack 구매 — prorate액(대략 starter_price*2/3)보다 확실히 크게, 방어선에
            # 안 걸리도록.
            pack_amount = starter_price * 10
            pack_order_id, pack_payment_key = await _seed_pack_purchase_order(
                session, org_id, amount_minor=pack_amount,
                created_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

            call_log = []

            async def _fake_post(self, path, **kwargs):
                call_log.append((path, kwargs.get("json")))
                if "cancel" in path:
                    return _toss_cancel_response(kwargs["json"]["cancelAmount"])
                return {"paymentKey": f"pay-new-{uuid.uuid4()}", "totalAmount": team_price}

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                await change_tier(session, org_id=org_id, new_tier="team")

            cancel_calls = [c for c in call_log if "cancel" in c[0]]
            assert len(cancel_calls) == 1
            targeted_pack = pack_payment_key in cancel_calls[0][0]
            targeted_sub = sub_payment_key in cancel_calls[0][0]
            assert not targeted_pack, "무관한 pack 구매가 취소되면 안 됨(카디르 재현 시나리오B)"
            assert targeted_sub, "구독 charge가 부분취소 대상이어야 함"

            pack_row = (
                await session.execute(text("SELECT refund_status FROM billing_orders WHERE order_id=:oid"), {"oid": pack_order_id})
            ).first()
            assert pack_row.refund_status is None, "pack 주문은 절대 건드리면 안 됨"
    finally:
        await engine.dispose()
