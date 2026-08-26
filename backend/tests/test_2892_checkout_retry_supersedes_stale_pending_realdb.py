"""story #2892(P0) — 페드루 판정(2026-08-21): org_subscriptions의 stale pending 잔재
(charge 실패가 남긴 상태, 실사고 org에서 실측됨 — tier='starter'·status='pending'·
checkout_claimed_at=NULL)를 raw SQL DELETE로 지우기 前에, **재시도가 코드 스스로 그
행을 처리(supersede)하는지**를 먼저 실측하라는 지시. 이 테스트가 그 실측이다.

재현 조건: 실사고 org와 동형인 stale pending 행(claim이 finally에서 이미 release돼
checkout_claimed_at=NULL인 상태 — org_subscription_checkout.py의 claim UPSERT WHERE
가드는 정확히 이 조건에서 새 claim을 허용한다)을 세팅해 두고 checkout_subscription()을
그대로(issue_billing_key/charge_org만 모킹 — Toss 네트워크 미접촉) 재호출한다.

결과가 ⓐ(CheckoutInProgress 없이 성공)면 raw SQL 불요(기존 pending 잔재는 재시도가
자연히 덮어씀) — ⓑ(막힘)면 그게 진짜 제품 버그(재결제 불가)라 별도 fix 스토리 대상."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


async def _seed_org_with_stale_pending_subscription(session) -> uuid.UUID:
    """실사고 org 실측 상태를 그대로 재현. offering_version(krw/starter)은 migration 0228이
    이미 공유 시드해 뒀다(test_2777_admin_billing_realdb.py 경고와 동일 함정) — 새로
    INSERT하면 uq_offering_versions_active_tier_currency 위반이라 기존 활성 행을 그대로
    재사용(checkout_subscription() 자신도 이 SELECT로 offering을 찾으므로 실제 경로와 동일)."""
    from sqlalchemy import select
    from app.models.organization import Organization
    from app.models.offering_version import OfferingVersion
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2892Retry", slug=f"org2892r-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()

    offering_id = (await session.execute(
        select(OfferingVersion.id).where(
            OfferingVersion.tier == "starter", OfferingVersion.currency == "krw",
            OfferingVersion.effective_to.is_(None),
        )
    )).scalar_one()

    now = datetime.now(timezone.utc)
    # 실사고 실측 그대로: tier=starter·status=pending·checkout_claimed_at=NULL(release됨).
    sub = OrgSubscription(
        id=uuid.uuid4(), org_id=org.id, tier="starter", billing_cycle="monthly",
        status="pending", provider="toss", currency="krw", offering_version_id=offering_id,
        current_period_start=now - timedelta(hours=1), current_period_end=now + timedelta(days=29),
        checkout_claimed_at=None,
    )
    session.add(sub)
    await session.commit()
    return org.id


@pytest.mark.asyncio
async def test_retry_checkout_supersedes_stale_pending_row_without_blocking():
    from app.services.org_subscription_checkout import checkout_subscription, CheckoutInProgress
    from app.models.billing_order import BillingOrder

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org_with_stale_pending_subscription(s)

        fake_order = BillingOrder(
            id=uuid.uuid4(), org_id=org_id, order_id="fake-retry-order",
            amount_minor=29000, currency="krw", status="confirmed",
        )

        async with Session() as s:
            with patch(
                "app.services.org_subscription_checkout.issue_billing_key", new=AsyncMock(return_value=None),
            ), patch(
                "app.services.org_subscription_checkout.charge_org", new=AsyncMock(return_value=fake_order),
            ):
                try:
                    result = await checkout_subscription(
                        s, org_id=org_id, auth_key="fake-auth-key-retry",
                        tier="starter", billing_cycle="monthly",
                    )
                except CheckoutInProgress as exc:
                    pytest.fail(
                        f"ⓑ 확定 — stale pending 잔재가 재시도를 막았다(진짜 제품 버그, "
                        f"raw SQL DELETE로 임시조치 후 별도 fix 스토리 필요): {exc}"
                    )

        # ⓐ 확定 — claim UPSERT가 stale pending 행을 그대로 덮어써 정상 진행됐고,
        # charge_org가 confirmed를 반환했으니 status가 active로 승격돼야 한다(코드의
        # 정공 설계 그대로 — 재시도가 스스로 치유).
        assert result.status == "active", (
            f"재시도가 claim은 통과했지만 최종 status가 active로 안 감(={result.status}) — "
            f"claim CAS(checkout_claimed_at==now)가 예상과 다르게 동작했을 가능성"
        )
        assert result.tier == "starter"
    finally:
        await engine.dispose()
