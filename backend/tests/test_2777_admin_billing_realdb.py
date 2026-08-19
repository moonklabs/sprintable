"""story #2777(E-ADMIN-REDESIGN·결제 운영) realdb 검증 — 빌링 재시도·사용권 부여 어드민
처리 액션. 핵심 검증축: ①credit_grant가 org_subscriptions.tier도 함께 바꾸는지(단독으론
아무것도 안 풀린다는 그라운딩의 역명제) ②강등 거부(422) ③재시도 already-handled(409)
④idempotency_key replay 시 구독 기간 무접촉(PO AC 리뷰 CHANGES①) ⑤amount_minor 서버
파생·원천없음 fail loud(PO AC 리뷰 CHANGES③). 로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, tier: str | None = None):
    from app.models.organization import Organization
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2777", slug=f"org2777-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    if tier is not None:
        session.add(OrgSubscription(id=uuid.uuid4(), org_id=org.id, tier=tier, status="active"))
        await session.flush()
    await session.commit()
    return org.id


async def _seed_offering(session, *, tier: str, currency: str = "krw", monthly_price_minor: int = 59000) -> int:
    """⚠️ CI는 이 테이블을 migration 0228이 이미 실데이터로 seed해 둔 **공유** 카탈로그다
    (free/starter/team/business × krw 4행 — 다른 실PG 테스트 파일들이 그 행을 전제로 돈다).
    여기서 무조건 INSERT하면 uq_offering_versions_active_tier_currency 위반이거나(로컬처럼
    비어있지 않은 한) 과거엔 "매 테스트 전 DELETE"로 피했는데 그게 그 공유 seed 자체를
    지워 다른 테스트 파일을 연쇄로 깨뜨렸다(실사고, 2026-08-18 CI RED).

    select-then-insert(TOCTOU)로 짰던 1차 수정도 실 CI 병렬/재실행 조건에서 재발했다
    (같은 tier를 여러 테스트가 거의 동시에 seed 시도) — [[feedback_check_then_insert_toctou]]
    교훈 그대로, DB의 실 UNIQUE 부분 인덱스(uq_offering_versions_active_tier_currency)에
    `ON CONFLICT DO NOTHING`으로 위임해 원자적으로 만든다(billing_ledger.py::
    record_ledger_entry와 동형 패턴). 존재하면(migration seed든 충돌한 내 삽입이든)
    그 값을 그대로 읽어 반환 — 호출부가 이 반환값 기준으로 assert."""
    from sqlalchemy import select
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from app.models.offering_version import OfferingVersion

    stmt = pg_insert(OfferingVersion).values(
        id=uuid.uuid4(), tier=tier, currency=currency, version_label="krw_v1_test",
        monthly_price_minor=monthly_price_minor, annual_price_minor=monthly_price_minor * 10,
        included_seats=5, extra_seat_price_minor=None, max_agents=None,
        au_limit=1000, realtime_connection_limit=10, storage_mb_limit=1024, max_file_mb=100,
        lab_credit_minor=0, rate_limit_per_min=60, automation_rule_limit=10, webhook_limit=5,
        event_replay_days=7, overage_allowed=True, pack_catalog=None,
        effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc), effective_to=None,
        created_by="test-seed",
    ).on_conflict_do_nothing(index_elements=["tier", "currency"], index_where=OfferingVersion.effective_to.is_(None))
    await session.execute(stmt)
    await session.commit()

    return (await session.execute(
        select(OfferingVersion.monthly_price_minor).where(
            OfferingVersion.tier == tier, OfferingVersion.currency == currency,
            OfferingVersion.effective_to.is_(None),
        )
    )).scalar_one()


async def _seed_failed_order(session, *, org_id, amount_minor=10000, currency="krw"):
    from app.models.billing_order import BillingOrder

    order = BillingOrder(
        id=uuid.uuid4(), org_id=org_id, order_id=f"ord-{uuid.uuid4().hex[:10]}",
        amount_minor=amount_minor, currency=currency, status="failed",
    )
    session.add(order)
    await session.commit()
    return order.order_id


@pytest.mark.asyncio
async def test_grant_credit_bumps_org_subscription_tier_not_just_ledger():
    """헤드라인① 역명제 — grant_credit 호출 후 org_subscriptions.tier가 실제로 바뀌어
    있어야 한다(record_ledger_entry 단독 호출이면 이 값은 안 바뀐다)."""
    from app.services.admin_billing import grant_credit
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            monthly_price = await _seed_offering(s, tier="team", monthly_price_minor=59000)

        async with maker() as s:
            entry = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상",
                currency="krw", idempotency_key=f"idem-{uuid.uuid4()}",
                actor_email="operator@moonklabs.com",
            )

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team"
            assert sub.status == "active"
            assert sub.current_period_end is not None
            assert entry.entry_type == "credit_grant"
            assert entry.amount_minor == monthly_price  # 서버 파생(offering_versions.monthly_price_minor × 1개월)
            assert entry.entry_metadata["prev_tier"] == "free"
            assert entry.entry_metadata["target_tier"] == "team"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_amount_derived_from_offering_scales_with_months():
    from app.services.admin_billing import grant_credit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            monthly_price = await _seed_offering(s, tier="business", monthly_price_minor=219000)

        async with maker() as s:
            entry = await grant_credit(
                s, org_id=org_id, target_tier="business", months=3, reason="CS 보상 3개월",
                currency="krw", idempotency_key=f"idem-{uuid.uuid4()}",
                actor_email="operator@moonklabs.com",
            )
        assert entry.amount_minor == monthly_price * 3
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_fails_loud_when_no_pricing_source():
    """PO 지적③ — 원천(offering_versions) 없는 tier/currency 조합은 지어낸 수를 남기지
    않고 422로 명시 거부한다. ⚠️CI는 krw_v1 4종(free/starter/team/business × krw)이
    migration 0228로 이미 seed돼 있으므로(공유 카탈로그, 지우면 안 됨 — 위 _seed_offering
    docstring 참고) "존재하는 실 tier"로는 이 음성경로를 재현 못 한다. 그라운딩 확認:
    A1 스코프가 krw_v1만 시드했고 USD 카탈로그는 별도(미시드) — currency='usd'는 어느
    tier든 실제로 원천이 없다."""
    from app.services.admin_billing import AdminBillingError, grant_credit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            # offering_versions(currency='usd') 시드 없음(의도적 — krw_v1만 존재하는 실 갭)

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await grant_credit(
                    s, org_id=org_id, target_tier="starter", months=1, reason="원천 없음 케이스",
                    currency="usd", idempotency_key=f"idem-{uuid.uuid4()}",
                    actor_email="operator@moonklabs.com",
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.code == "PRICING_SOURCE_UNAVAILABLE"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_rejects_downgrade_with_422():
    from app.services.admin_billing import AdminBillingError, grant_credit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")
            await _seed_offering(s, tier="starter", monthly_price_minor=29000)

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await grant_credit(
                    s, org_id=org_id, target_tier="starter", months=1, reason="실수 테스트",
                    currency="krw", idempotency_key=f"idem-{uuid.uuid4()}",
                    actor_email="operator@moonklabs.com",
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.code == "GRANT_WOULD_DOWNGRADE"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_same_idempotency_key_does_not_duplicate_ledger_entry():
    from app.services.admin_billing import grant_credit
    from app.models.billing_ledger_entry import BillingLedgerEntry
    from sqlalchemy import select, func

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_offering(s, tier="team", monthly_price_minor=59000)
        key = f"idem-{uuid.uuid4()}"

        async with maker() as s:
            first = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상",
                currency="krw", idempotency_key=key,
                actor_email="operator@moonklabs.com",
            )
        async with maker() as s:
            second = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상(재전송)",
                currency="krw", idempotency_key=key,
                actor_email="operator@moonklabs.com",
            )

        assert first.id == second.id  # 같은 엔트리 재반환(멱등)

        async with maker() as s:
            count = (await s.execute(
                select(func.count()).select_from(BillingLedgerEntry).where(BillingLedgerEntry.org_id == org_id)
            )).scalar_one()
            assert count == 1  # 중복 기록 없음
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_replay_does_not_touch_subscription_period():
    """PO AC 리뷰 CHANGES①(블로커) — 같은 idempotency_key 재전송(타임아웃 재시도 등)이
    구독 기간을 다시 밀지 않아야 한다. 이전 버전은 tier bump를 항상 먼저 flush해 매
    replay마다 current_period_end가 now+months로 재세팅되는 결함이 있었다."""
    from app.services.admin_billing import grant_credit
    from app.models.org_subscription import OrgSubscription
    from sqlalchemy import select

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="free")
            await _seed_offering(s, tier="team", monthly_price_minor=59000)
        key = f"idem-{uuid.uuid4()}"

        async with maker() as s:
            await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="최초",
                currency="krw", idempotency_key=key, actor_email="operator@moonklabs.com",
            )
        async with maker() as s:
            period_end_after_first = (
                await s.execute(select(OrgSubscription.current_period_end).where(OrgSubscription.org_id == org_id))
            ).scalar_one()

        # 두 번째 호출은 나중 시각(now 다르게)로 명시 — replay면 period_end가 그 시각 기준으로
        # 다시 안 밀려야 한다.
        async with maker() as s:
            await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="재전송",
                currency="krw", idempotency_key=key, actor_email="operator@moonklabs.com",
                now=datetime(2026, 9, 1, tzinfo=timezone.utc),
            )
        async with maker() as s:
            period_end_after_replay = (
                await s.execute(select(OrgSubscription.current_period_end).where(OrgSubscription.org_id == org_id))
            ).scalar_one()

        assert period_end_after_replay == period_end_after_first
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_retry_billing_order_returns_409_when_not_failed():
    from app.services.admin_billing import AdminBillingError, retry_billing_order
    from app.models.billing_order import BillingOrder

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s)
            order = BillingOrder(
                id=uuid.uuid4(), org_id=org_id, order_id=f"ord-{uuid.uuid4().hex[:10]}",
                amount_minor=10000, currency="krw", status="confirmed",
            )
            s.add(order)
            await s.commit()
            order_id = order.order_id

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await retry_billing_order(s, org_id=org_id, order_id=order_id, actor_email="operator@moonklabs.com")
            assert exc_info.value.status_code == 409
            assert exc_info.value.code == "ALREADY_HANDLED"
            assert "confirmed" in exc_info.value.message
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_retry_billing_order_404_when_order_belongs_to_different_org():
    """IDOR류 방어 — order_id는 유효해도 org_id가 다르면 404(«남의 org 주문을 내가 재시도».
    session_seq 8/#1555 계보의 리소스 스코프 검증 원칙과 동형)."""
    from app.services.admin_billing import AdminBillingError, retry_billing_order

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_a = await _seed_org(s)
            org_b = await _seed_org(s)
            order_id = await _seed_failed_order(s, org_id=org_a)

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await retry_billing_order(s, org_id=org_b, order_id=order_id, actor_email="operator@moonklabs.com")
            assert exc_info.value.status_code == 404
    finally:
        await engine.dispose()
