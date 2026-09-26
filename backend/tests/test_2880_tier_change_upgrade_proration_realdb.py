"""story #2880(결제 트랙 갭①) — 월납 유료→유료 상향의 **남은 두 조각**을 실 PG로 잰다.

story #4344 — 옛 동기 경로 `change_tier()`(청구 → tier 전이 → 옛 결제 부분취소를 한 호출에서)는 결제 시도(story #4335) 뒤
운영 호출처 0이라 걷혔다. 그 함수를 통째로 돌리던 테스트(전액 청구 · 거절 · 부분취소 실패 · 동시 호출)는 같은 사실을 결제 시도
경로로 재는 `test_4335_payment_attempts_realdb.py`가 맡는다(대조표는 PR 4344 본문). 여기 남는 것은 결제 시도도 그대로 부르는
두 도우미:
  AC⑤: `validate_change_tier` — annual/하향/동일 tier는 TierChangeError(400 매핑 대상).
  카디르 재현(PR#3306): `latest_confirmed_subscription_order` — 부분취소 대상은 구독 charge(더 최근 pack 구매 아님).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


@pytest.mark.anyio
async def test_annual_billing_cycle_rejected_realdb():
    """AC⑤ — 연납 중 상향은 이 스토리 범위 밖(공식 문서 확定 선행), TierChangeError."""
    from app.services.org_subscription_tier_change import TierChangeError, validate_change_tier

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
                await validate_change_tier(session, org_id=org_id, new_tier="team")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_downgrade_direction_rejected_realdb():
    """AC⑤+ⓓ — team→starter(하향)는 이 엔진이 아니라 story #2881 몫, TierChangeError."""
    from app.services.org_subscription_tier_change import TierChangeError, validate_change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="team")
            await _seed_active_billing_key(session, org_id)

            with pytest.raises(TierChangeError, match="상향이 아님"):
                await validate_change_tier(session, org_id=org_id, new_tier="starter")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_same_tier_rejected_realdb():
    """AC⑤+ⓓ — 동일 tier 재제출도 상향이 아님."""
    from app.services.org_subscription_tier_change import TierChangeError, validate_change_tier

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="team")
            await _seed_active_billing_key(session, org_id)

            with pytest.raises(TierChangeError, match="상향이 아님"):
                await validate_change_tier(session, org_id=org_id, new_tier="team")
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
    from app.services.org_subscription_tier_change import latest_confirmed_subscription_order

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_start = datetime.now(timezone.utc) - timedelta(days=10)
            period_end = period_start + timedelta(days=30)
            _, starter_price = await _offering(session, "starter")

            await _seed_active_paid_subscription(session, org_id, tier="starter", period_start=period_start, period_end=period_end)
            await _seed_active_billing_key(session, org_id)
            # 구독 charge(10일 전, starter_price) — 부분취소 진짜 대상.
            sub_order_id, _sub_payment_key = await _seed_prior_confirmed_order(
                session, org_id, amount_minor=starter_price, created_at=period_start,
            )
            # pack 구매(1일 전, 구독 charge보다 최근이지만 소액) — 오인 대상이면 안 됨.
            pack_amount = 5_000
            await _seed_pack_purchase_order(
                session, org_id, amount_minor=pack_amount,
                created_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

            # story #4344 — 옛 동기 `change_tier()`는 걷혔다. 같은 대상 선택을 지금 쓰는 곳은 결제 시도의 요금제 변경
            # (`billing_payment_attempt.start_change_tier_attempt` → `latest_confirmed_subscription_order`) — 그 선택을 직접 잰다.
            target = await latest_confirmed_subscription_order(session, org_id)
            assert target is not None and target.order_id == sub_order_id, "부분취소 대상은 구독 order여야 함(pack 아님)"
            assert target.purpose == "charge"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_refund_does_not_silently_cancel_unrelated_pack_purchase_when_pack_amount_larger_realdb():
    """시나리오 B(카디르 재현②, 더 위험) — pack금액이 prorate액보다 클 때. 정정 前엔
    refund_org의 「초과 금액 방어」가 안 걸려(pack 주문 자체 금액이 충분히 커서)
    무관한 고객의 정상 pack 구매가 조용히 부분취소됐다(refund_status='confirmed'로
    기록되지만 targeted_pack=True, targeted_sub=False — 아무 에러도 없이 잘못된 돈이
    빠져나감). 정정 後엔 애초에 pack 주문이 후보에 들지 않아야 한다."""
    from app.services.org_subscription_tier_change import latest_confirmed_subscription_order

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_start = datetime.now(timezone.utc) - timedelta(days=10)
            period_end = period_start + timedelta(days=30)
            _, starter_price = await _offering(session, "starter")

            await _seed_active_paid_subscription(session, org_id, tier="starter", period_start=period_start, period_end=period_end)
            await _seed_active_billing_key(session, org_id)
            sub_order_id, _sub_payment_key = await _seed_prior_confirmed_order(
                session, org_id, amount_minor=starter_price, created_at=period_start,
            )
            # pack 구매 — prorate액(대략 starter_price*2/3)보다 확실히 크게, 방어선에
            # 안 걸리도록.
            pack_amount = starter_price * 10
            pack_order_id, _pack_payment_key = await _seed_pack_purchase_order(
                session, org_id, amount_minor=pack_amount,
                created_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

            # story #4344 — 결제 시도 경로가 쓰는 대상 선택을 직접(시나리오 B: pack이 더 크고 더 최근이어도 후보가 아님).
            target = await latest_confirmed_subscription_order(session, org_id)
            assert target is not None and target.order_id == sub_order_id, "구독 charge가 부분취소 대상이어야 함"
            assert target.order_id != pack_order_id, "무관한 pack 구매가 대상이면 안 됨(카디르 재현 시나리오B)"
    finally:
        await engine.dispose()
