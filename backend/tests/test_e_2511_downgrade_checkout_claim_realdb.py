"""#2511 후속(PO 지적, #2896 리뷰, 2026-08-07) real-DB — downgrade_to_free가 진행 中인
checkout claim(checkout_claimed_at)을 존중하는지 실 org_subscriptions/billing_orders
위에서 검증. "유료청구는 됐는데 tier=free"라는 영구 오염을 막는 게 목적.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
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


async def _seed_stale_failed_order(session, *, org_id, now):
    """8일 전 실패한 order — dunning §12.1 케이던스상 downgrade_to_free 대상."""
    order_id = f"ord-stale-{uuid.uuid4()}"
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, created_at, updated_at) "
            "VALUES (:id, :org_id, :order_id, 29000, 'krw', 'failed', :created_at, :created_at)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "order_id": order_id, "created_at": now - timedelta(days=9)},
    )
    await session.commit()
    return order_id


@pytest.mark.anyio
async def test_downgrade_to_free_does_not_clobber_org_with_active_checkout_claim_realdb():
    """진행 中인(staleness 안 넘긴) checkout claim이 있으면 free upsert를 건너뛴다 —
    claim이 성공했지만 issue_billing_key/charge_org가 아직 안 끝나 다른 두 회복증거
    (더 나중 confirmed order·더 나중 발급 billing_key)가 아직 없는 그 창을 재현."""
    from app.services.billing_scheduler import downgrade_to_free

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            now = datetime.now(timezone.utc)
            order_id = await _seed_stale_failed_order(session, org_id=org_id, now=now)

            # 진행 中인 checkout claim 재현 — claim만 성공하고 아직 charge_org 前인 상태
            # (tier='starter', status='pending', checkout_claimed_at=방금).
            await session.execute(
                text(
                    "INSERT INTO org_subscriptions (id, org_id, tier, status, provider, currency, checkout_claimed_at) "
                    "VALUES (:id, :org_id, 'starter', 'pending', 'toss', 'krw', :claimed_at)"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "claimed_at": now},
            )
            await session.commit()

            await downgrade_to_free(session, org_id, order_id)

            row = (
                await session.execute(
                    text("SELECT tier, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row.tier == "starter"  # free로 오염 안 됨(fix 검증 핵심)
            assert row.status == "pending"  # checkout이 아직 진행 中이라는 사실 그대로

            # order는 여전히 닫힌다(재처리 방지 목적은 유지).
            order_status = (
                await session.execute(
                    text("SELECT status FROM billing_orders WHERE order_id=:oid"), {"oid": order_id}
                )
            ).scalar_one()
            assert order_status == "downgraded"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_downgrade_to_free_proceeds_when_checkout_claim_is_stale_realdb():
    """staleness를 넘긴(=죽은/멈춘) claim은 무시하고 정상 downgrade — 자기치유 회귀 없음."""
    from app.services.billing_scheduler import downgrade_to_free
    from app.services.org_subscription_checkout import STALE_CLAIM_WINDOW

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            now = datetime.now(timezone.utc)
            order_id = await _seed_stale_failed_order(session, org_id=org_id, now=now)

            stale_claim_at = now - STALE_CLAIM_WINDOW - timedelta(minutes=1)
            await session.execute(
                text(
                    "INSERT INTO org_subscriptions (id, org_id, tier, status, provider, currency, checkout_claimed_at) "
                    "VALUES (:id, :org_id, 'starter', 'pending', 'toss', 'krw', :claimed_at)"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "claimed_at": stale_claim_at},
            )
            await session.commit()

            await downgrade_to_free(session, org_id, order_id)

            row = (
                await session.execute(
                    text("SELECT tier, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                )
            ).first()
            assert row.tier == "free"  # 죽은 claim은 회복 증거로 안 쳐줌 — 정상 downgrade
            assert row.status == "active"
    finally:
        await engine.dispose()
