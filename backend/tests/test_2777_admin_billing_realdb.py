"""story #2777(E-ADMIN-REDESIGN·결제 운영) realdb 검증 — 빌링 재시도·사용권 부여 어드민
처리 액션. 핵심 검증축: ①credit_grant가 org_subscriptions.tier도 함께 바꾸는지(단독으론
아무것도 안 풀린다는 그라운딩의 역명제) ②강등 거부(422) ③재시도 already-handled(409)
④idempotency_key 재사용 시 중복 grant 없음. 로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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

        async with maker() as s:
            entry = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상",
                amount_minor=59000, currency="krw", idempotency_key=f"idem-{uuid.uuid4()}",
                actor_email="operator@moonklabs.com",
            )

        async with maker() as s:
            sub = (await s.execute(select(OrgSubscription).where(OrgSubscription.org_id == org_id))).scalar_one()
            assert sub.tier == "team"
            assert sub.status == "active"
            assert sub.current_period_end is not None
            assert entry.entry_type == "credit_grant"
            assert entry.entry_metadata["prev_tier"] == "free"
            assert entry.entry_metadata["target_tier"] == "team"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_grant_credit_rejects_downgrade_with_422():
    from app.services.admin_billing import AdminBillingError, grant_credit

    engine, maker = await _session_factory()
    try:
        async with maker() as s:
            org_id = await _seed_org(s, tier="team")

        async with maker() as s:
            with pytest.raises(AdminBillingError) as exc_info:
                await grant_credit(
                    s, org_id=org_id, target_tier="starter", months=1, reason="실수 테스트",
                    amount_minor=1000, currency="krw", idempotency_key=f"idem-{uuid.uuid4()}",
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
        key = f"idem-{uuid.uuid4()}"

        async with maker() as s:
            first = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상",
                amount_minor=59000, currency="krw", idempotency_key=key,
                actor_email="operator@moonklabs.com",
            )
        async with maker() as s:
            second = await grant_credit(
                s, org_id=org_id, target_tier="team", months=1, reason="CS 보상(재전송)",
                amount_minor=59000, currency="krw", idempotency_key=key,
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
                await retry_billing_order(s, org_id=org_id, order_id=order_id)
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
                await retry_billing_order(s, org_id=org_b, order_id=order_id)
            assert exc_info.value.status_code == 404
    finally:
        await engine.dispose()
