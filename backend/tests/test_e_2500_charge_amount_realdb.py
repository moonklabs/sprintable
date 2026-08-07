"""#2500 real-DB — compute_charge_amount이 실제 seed된 offering_versions(krw_v1) +
org_members + org_subscriptions 위에서 정확히 도는지 증명.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 로컬 PG(alembic upgrade head 적용된 DB) 전제."""
from __future__ import annotations

import os
import uuid

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


async def _seed_org(session, *, tier: str, billing_cycle: str, human_seats: int):
    org_id = uuid.uuid4()
    offering_id = (
        await session.execute(
            text("SELECT id FROM offering_versions WHERE tier=:t AND version_label='krw_v1'"),
            {"t": tier},
        )
    ).scalar_one()
    sub_id = uuid.uuid4()
    await session.execute(
        text(
            "INSERT INTO org_subscriptions (id, org_id, tier, billing_cycle, status, currency, "
            "provider, offering_version_id) VALUES "
            "(:id, :org_id, :tier, :cycle, 'active', 'krw', 'toss', :offering_id)"
        ),
        {"id": sub_id, "org_id": org_id, "tier": tier, "cycle": billing_cycle, "offering_id": offering_id},
    )
    for _ in range(human_seats):
        await session.execute(
            text(
                "INSERT INTO org_members (id, org_id, user_id, role) "
                "VALUES (:id, :org_id, :user_id, 'member')"
            ),
            {"id": uuid.uuid4(), "org_id": org_id, "user_id": uuid.uuid4()},
        )
    await session.commit()
    return org_id


@pytest.mark.anyio
async def test_team_tier_no_overage_realdb():
    from app.services.billing_charge_amount import compute_charge_amount

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session, tier="team", billing_cycle="monthly", human_seats=5)
            amount, currency = await compute_charge_amount(session, org_id=org_id)
            assert amount == 59_000
            assert currency == "krw"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_team_tier_seat_overage_realdb():
    from app.services.billing_charge_amount import compute_charge_amount

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            # included_seats=5, 7명 실좌석 → 2석 초과 * 11,000
            org_id = await _seed_org(session, tier="team", billing_cycle="monthly", human_seats=7)
            amount, currency = await compute_charge_amount(session, org_id=org_id)
            assert amount == 59_000 + 2 * 11_000
            assert currency == "krw"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_business_tier_annual_cycle_realdb():
    from app.services.billing_charge_amount import compute_charge_amount

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session, tier="business", billing_cycle="annual", human_seats=15)
            amount, currency = await compute_charge_amount(session, org_id=org_id)
            assert amount == 2_190_000
            assert currency == "krw"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_starter_seat_overage_raises_realdb():
    from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session, tier="starter", billing_cycle="monthly", human_seats=4)
            with pytest.raises(ChargeAmountError, match="starter"):
                await compute_charge_amount(session, org_id=org_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pack_purchase_ledger_entries_included_when_period_set_realdb():
    from app.services.billing_ledger import record_ledger_entry
    from app.services.billing_charge_amount import compute_charge_amount

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session, tier="team", billing_cycle="monthly", human_seats=5)
            sub_id = (
                await session.execute(
                    text("SELECT id FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id}
                )
            ).scalar_one()
            await session.execute(
                text(
                    "UPDATE org_subscriptions SET current_period_start = now() - interval '10 days', "
                    "current_period_end = now() + interval '20 days' WHERE org_id=:oid"
                ),
                {"oid": org_id},
            )
            await session.commit()
            await record_ledger_entry(
                session, org_id=org_id, entry_type="pack_purchase", amount_minor=7_000,
                currency="krw", direction="debit", subscription_id=sub_id,
                provider_ref=f"pack-{uuid.uuid4()}",
            )

            amount, _ = await compute_charge_amount(session, org_id=org_id)
            assert amount == 59_000 + 7_000
    finally:
        await engine.dispose()
