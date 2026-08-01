"""E-ADMIN B1(story 553fc58d) real-DB — ee/billing.py._update_subscription이 grandfather
FK(org_subscriptions.pricing_version_id)를 현재 유효 pricing_version으로 채우는지 검증.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡 env에서 실행/로컬 PG."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("b1000000-0000-0000-0000-000000000001")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _reset(session):
    # 0147 마이그가 team/pro × monthly/yearly × usd/krw 실 시드를 이미 넣어두므로, 이 테스트가
    # 쓰는 정확히 같은 계보(team/monthly/usd·pro/monthly/usd·pro/yearly/usd)를 명시적으로
    # 비워야 테스트가 격리된다(안 그러면 실 시드 행이 effective_from 최신이라 테스트 행을
    # 이겨버림 — 코드 버그가 아니라 테스트 격리 버그였음, 실증 중 발견해 수정).
    for sql in [
        f"DELETE FROM org_subscriptions WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','B1Org','b1org','free')",
        "DELETE FROM pricing_versions WHERE polar_price_id LIKE 'test-b1-%'",
        "DELETE FROM pricing_versions WHERE (tier,billing_cycle,currency) IN "
        "(('team','monthly','usd'),('pro','monthly','usd'),('pro','yearly','usd'))",
    ]:
        await session.execute(text(sql))
    await session.commit()


@pytest.mark.anyio
async def test_update_subscription_sets_current_pricing_version_id():
    from ee.routers.billing import _update_subscription
    from app.models.org_subscription import OrgSubscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _reset(session)

            now = datetime.now(timezone.utc)
            pv_id = uuid.uuid4()
            await session.execute(
                text(
                    "INSERT INTO pricing_versions (id, tier, billing_cycle, currency, price_cents, "
                    "polar_price_id, effective_from, created_by) VALUES "
                    "(:id, 'team', 'monthly', 'usd', 4900, 'test-b1-team-monthly', :eff, 'test')"
                ),
                {"id": pv_id, "eff": now - timedelta(days=1)},
            )
            await session.commit()

            await _update_subscription(session, ORG, "team", "monthly", "cus_test", "sub_test", "active")

            row = (
                await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == ORG))
            ).scalar_one()
            assert row.pricing_version_id == pv_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_update_subscription_none_when_no_pricing_version_exists():
    from ee.routers.billing import _update_subscription
    from app.models.org_subscription import OrgSubscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _reset(session)

            # pro/yearly에 대해 아무 pricing_version도 시드하지 않음 — FK는 NULL이어야(에러 아님).
            await _update_subscription(session, ORG, "pro", "yearly", "cus_test2", "sub_test2", "active")

            row = (
                await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == ORG))
            ).scalar_one()
            assert row.pricing_version_id is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_update_subscription_plan_change_refreshes_pricing_version_id():
    from ee.routers.billing import _update_subscription
    from app.models.org_subscription import OrgSubscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _reset(session)
            now = datetime.now(timezone.utc)
            team_pv = uuid.uuid4()
            pro_pv = uuid.uuid4()
            await session.execute(
                text(
                    "INSERT INTO pricing_versions (id, tier, billing_cycle, currency, price_cents, "
                    "polar_price_id, effective_from, created_by) VALUES "
                    "(:id, 'team', 'monthly', 'usd', 4900, 'test-b1-team-monthly-2', :eff, 'test')"
                ),
                {"id": team_pv, "eff": now - timedelta(days=1)},
            )
            await session.execute(
                text(
                    "INSERT INTO pricing_versions (id, tier, billing_cycle, currency, price_cents, "
                    "polar_price_id, effective_from, created_by) VALUES "
                    "(:id, 'pro', 'monthly', 'usd', 14900, 'test-b1-pro-monthly', :eff, 'test')"
                ),
                {"id": pro_pv, "eff": now - timedelta(days=1)},
            )
            await session.commit()

            await _update_subscription(session, ORG, "team", "monthly", "cus_test3", "sub_test3", "active")
            await _update_subscription(session, ORG, "pro", "monthly", "cus_test3", "sub_test3", "active")

            row = (
                await session.execute(select(OrgSubscription).where(OrgSubscription.org_id == ORG))
            ).scalar_one()
            assert row.pricing_version_id == pro_pv  # 플랜변경 후 새 플랜의 버전으로 갱신
    finally:
        await engine.dispose()
