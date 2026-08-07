"""#2509① real-DB — downgrade_to_free의 "다른-order 재구독 클로버" 결함 fix 실증.
카디르 결함사냥(2026-08-07): stale failed order 스윕이 org의 현재 상태를 안 보고
무조건 free upsert해, 다른 order로 이미 재구독(pro) 성공한 org를 덮어썼다.

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


async def _seed_paid_org(session, *, tier="team"):
    org_id = uuid.uuid4()
    offering_id = (
        await session.execute(
            text("SELECT id FROM offering_versions WHERE tier=:t AND version_label='krw_v1'"),
            {"t": tier},
        )
    ).scalar_one()
    await session.execute(
        text(
            "INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, currency, "
            "provider, offering_version_id) VALUES "
            "(:id, :org_id, :tier, 'monthly', 'active', 'krw', 'toss', :offering_id)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "tier": tier, "offering_id": offering_id},
    )
    await session.commit()
    return org_id


async def _seed_stale_failed_order(session, *, org_id, created_days_ago=9):
    order_id = f"ord-stale-{uuid.uuid4()}"
    created_at = datetime.now(timezone.utc) - timedelta(days=created_days_ago)
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, "
            "created_at, updated_at) VALUES "
            "(:id, :org_id, :order_id, 59000, 'krw', 'failed', :created_at, :created_at)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "order_id": order_id, "created_at": created_at},
    )
    await session.commit()
    return order_id


async def _get_tier(session, org_id):
    return (
        await session.execute(
            text("SELECT tier FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
        )
    ).scalar_one()


async def _get_order_status(session, order_id):
    return (
        await session.execute(
            text("SELECT status FROM billing_orders WHERE order_id=:oid"), {"oid": order_id}
        )
    ).scalar_one()


@pytest.mark.anyio
async def test_stale_order_does_not_clobber_org_that_already_resubscribed_via_other_order():
    """실측 — org가 stale order(order_A, 9일 전 failed)와 별개로 order_B(신규, confirmed)
    로 이미 재구독 성공한 상태. downgrade_to_free(order_A)가 뒤늦게 돌아도 tier=pro가
    유지돼야 한다(클로버 안 됨) — order_A는 여전히 닫혀야(재처리 방지)."""
    from app.services.billing_scheduler import downgrade_to_free

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_paid_org(session, tier="team")
            stale_order_id = await _seed_stale_failed_order(session, org_id=org_id, created_days_ago=9)

            # order_A보다 "나중에" 생성된 confirmed order_B — 재구독 성공 증거.
            newer_order_id = f"ord-newer-{uuid.uuid4()}"
            await session.execute(
                text(
                    "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, "
                    "status, payment_key, created_at, updated_at) VALUES "
                    "(:id, :org_id, :order_id, 59000, 'krw', 'confirmed', :pk, now(), now())"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "order_id": newer_order_id, "pk": f"pay-{uuid.uuid4()}"},
            )
            await session.commit()

            await downgrade_to_free(session, org_id, stale_order_id)

            assert await _get_tier(session, org_id) == "team"  # clobber 안 됨
            assert await _get_order_status(session, stale_order_id) == "downgraded"  # 그래도 닫힘
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stale_order_downgrades_when_no_recovery_evidence_positive_control():
    """양성대조 — 회복 증거(더 나중 confirmed order·더 나중 billing_key)가 전혀 없으면
    가드가 정상적으로 free 강등을 수행해야 한다(가드가 과하게 걸려 정당한 다운그레이드를
    막지 않는지 실증)."""
    from app.services.billing_scheduler import downgrade_to_free

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_paid_org(session, tier="team")
            stale_order_id = await _seed_stale_failed_order(session, org_id=org_id, created_days_ago=9)

            await downgrade_to_free(session, org_id, stale_order_id)

            assert await _get_tier(session, org_id) == "free"
            assert await _get_order_status(session, stale_order_id) == "downgraded"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stale_order_does_not_clobber_when_newly_issued_billing_key_exists():
    """order_A보다 나중에 발급된 활성 billing_key가 있으면(재인증 진행 중 race 윈도)
    마찬가지로 free 강등을 건너뛴다."""
    from app.services.billing_scheduler import downgrade_to_free

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_paid_org(session, tier="team")
            stale_order_id = await _seed_stale_failed_order(session, org_id=org_id, created_days_ago=9)

            await session.execute(
                text(
                    "INSERT INTO org_billing_keys (id, org_id, customer_key, encrypted_billing_key, "
                    "status, issued_at) VALUES (:id, :org_id, :ck, 'enc-placeholder', 'active', now())"
                ),
                {"id": uuid.uuid4(), "org_id": org_id, "ck": f"cust-{uuid.uuid4()}"},
            )
            await session.commit()

            await downgrade_to_free(session, org_id, stale_order_id)

            assert await _get_tier(session, org_id) == "team"
            assert await _get_order_status(session, stale_order_id) == "downgraded"
    finally:
        await engine.dispose()
