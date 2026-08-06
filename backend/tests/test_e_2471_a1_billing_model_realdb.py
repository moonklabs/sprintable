"""#2471(A1) real-DB — 0228 마이그가 실제로 만든 제약이 «잡는다»는 것을 직접 증명한다.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡 env에서 실행/로컬 PG
(alembic upgrade head 가 이미 적용된 DB를 전제한다)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_offering_versions_seeded_with_four_krw_v1_tiers():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT tier, monthly_price_minor, included_seats, au_limit "
                        "FROM offering_versions WHERE version_label = 'krw_v1' AND currency = 'krw' "
                        "ORDER BY monthly_price_minor"
                    )
                )
            ).all()
            assert [r[0] for r in rows] == ["free", "starter", "team", "business"]
            assert [r[1] for r in rows] == [0, 29_000, 59_000, 219_000]
            assert [r[2] for r in rows] == [3, 3, 5, 15]
            assert [r[3] for r in rows] == [50_000, 150_000, 1_000_000, 10_000_000]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_offering_versions_reject_second_active_row_same_tier_currency():
    """양성대조 — unique partial index(tier,currency) WHERE effective_to IS NULL이 실제로 잡는가."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            with pytest.raises(IntegrityError, match="uq_offering_versions_active_tier_currency"):
                await session.execute(
                    text(
                        "INSERT INTO offering_versions "
                        "(tier, currency, version_label, monthly_price_minor, annual_price_minor, "
                        "included_seats, au_limit, realtime_connection_limit, storage_mb_limit, "
                        "max_file_mb, lab_credit_minor, rate_limit_per_min, automation_rule_limit, "
                        "webhook_limit, event_replay_days, overage_allowed, effective_from, created_by) "
                        "VALUES ('free','krw','krw_v2_test',0,0,3,50000,10,5120,100,500,120,3,0,7,"
                        "false,now(),'test')"
                    )
                )
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_subscriptions_provider_must_match_currency():
    """양성대조 — provider=f(currency) 불변식(krw→toss·usd→polar)을 DB CHECK가 실제로 강제."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            with pytest.raises(IntegrityError, match="org_subscriptions_provider_currency_fn"):
                await session.execute(
                    text(
                        "INSERT INTO org_subscriptions (id, org_id, currency, provider) "
                        "VALUES (gen_random_uuid(), :oid, 'krw', 'polar')"
                    ),
                    {"oid": org_id},
                )
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_subscriptions_polar_customer_id_now_nullable():
    """provider-agnostic화 — Toss(원화) 구독은 Polar customer가 없어도 저장 가능해야 한다."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            await session.execute(
                text("INSERT INTO org_subscriptions (id, org_id) VALUES (gen_random_uuid(), :oid)"),
                {"oid": org_id},
            )
            await session.commit()
            row = (
                await session.execute(
                    text("SELECT polar_customer_id FROM org_subscriptions WHERE org_id = :oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row[0] is None
            await session.execute(text("DELETE FROM org_subscriptions WHERE org_id = :oid"), {"oid": org_id})
            await session.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_plan_tier_limits_has_starter_and_business_without_touching_existing_rows():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            rows = dict(
                (r[0], (r[1], r[2]))
                for r in (await session.execute(text("SELECT tier, max_storage_mb, max_file_mb FROM plan_tier_limits"))).all()
            )
            assert rows["starter"] == (10 * 1024, 300)
            assert rows["business"] == (250 * 1024, 1000)
            # 기존 free/team/pro 행 — 0140 결재값 그대로, A1이 건드리지 않았음을 증명.
            assert rows["free"] == (5 * 1024, 100)
            assert rows["team"] == (50 * 1024, 500)
            assert rows["pro"] == (250 * 1024, 500)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_grandfather_policies_rejects_second_active_policy_same_org():
    """양성대조 — org당 active grandfather_policy는 1건만(unique partial index)."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = uuid.uuid4()
            offering_id = (
                await session.execute(
                    text(
                        "SELECT id FROM offering_versions WHERE tier='free' AND currency='krw' "
                        "AND version_label='krw_v1'"
                    )
                )
            ).scalar_one()
            await session.execute(
                text(
                    "INSERT INTO grandfather_policies "
                    "(org_id, offering_version_id, reason, effective_from, created_by) "
                    "VALUES (:oid, :ov, 'signup', now(), 'test')"
                ),
                {"oid": org_id, "ov": offering_id},
            )
            await session.commit()
            try:
                with pytest.raises(IntegrityError, match="uq_grandfather_policies_active_org"):
                    await session.execute(
                        text(
                            "INSERT INTO grandfather_policies "
                            "(org_id, offering_version_id, reason, effective_from, created_by) "
                            "VALUES (:oid, :ov, 'plan_change', now(), 'test')"
                        ),
                        {"oid": org_id, "ov": offering_id},
                    )
                    await session.commit()
                await session.rollback()
            finally:
                await session.execute(text("DELETE FROM grandfather_policies WHERE org_id = :oid"), {"oid": org_id})
                await session.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pricing_versions_pro_remapped_to_business_no_data_loss():
    """0147 live seed(team/pro×monthly/yearly×usd/krw 10건)가 A1 후 business로 재라벨링되고
    provider_price_ref(실 Polar/Toss price id)는 그대로 보존됐는지 — 무손실 전환 증명."""
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            tiers = (
                await session.execute(text("SELECT DISTINCT tier FROM pricing_versions"))
            ).scalars().all()
            assert "pro" not in tiers
            business_count = (
                await session.execute(text("SELECT COUNT(*) FROM pricing_versions WHERE tier = 'business'"))
            ).scalar()
            # 다른 realdb 테스트(test_e_admin_b1_grandfather_wiring_realdb)가 자기 격리를 위해
            # 특정 (tier,billing_cycle,currency) 행을 지웠다 다시 채우기도 하므로 정확한 개수
            # 대신 "0건이 아니다"만 본다 — 이 테스트가 확인할 것은 'pro' 잔존 여부와 재라벨링된
            # 행의 provider_price_ref 무손실이지, 다른 테스트의 격리 delete까지 막는 게 아니다.
            assert business_count > 0
            null_refs = (
                await session.execute(
                    text(
                        "SELECT COUNT(*) FROM pricing_versions WHERE tier = 'business' "
                        "AND provider_price_ref IS NULL"
                    )
                )
            ).scalar()
            assert null_refs == 0  # business로 옮겨진 행도 원래 Polar/Toss price id를 유지
    finally:
        await engine.dispose()
