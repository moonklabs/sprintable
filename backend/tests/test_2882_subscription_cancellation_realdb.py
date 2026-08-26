"""story #2882(구독 취소, 선생님 확定 2026-08-21) — 실PG 검증. v2.1 §12 「월간 구독
취소: 현재 기간 말까지 사용, 다음 갱신 중지, 부분 환불 없음」 — «tier=free로의 하향»으로
취급, #2881의 pending_* 슬롯·`sweep_pending_tier_downgrades`를 그대로 재사용한다.

커버:
  AC① — 취소 예약이 즉시 전이 없이 pending_tier='free'만 기록(현재 tier 무변화).
  AC② — 활성 유료 구독이 아니면 취소 예약 거부(DowngradeError).
  AC③ — 철회(POST 취소 후 DELETE)는 pending_*만 클리어, 구독 원 tier 무변화.
  AC④ — sweep이 갱신일에 free로 실제 전이(billing_cycle/period 클리어).
  ⛔AC⑤(선생님 확定 핵심) — 좌석 초과 상태에서도 취소는 **거부되지 않는다**(하향과
  달리 seat gate를 안 탐) — 기존 멤버는 제거되지 않고, free 전이 後 신규 좌석 추가만
  기존 `ee/plan_limits.check_member_invite_limit`이 자연히 막는다.
  ⑥ — 하향 예약과 취소 예약은 같은 슬롯 — 서로 재예약(덮어씀) 가능.
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


async def _seed_org(session):
    org_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.commit()
    return org_id


async def _offering_id(session, tier):
    row = (
        await session.execute(
            text("SELECT id, included_seats FROM offering_versions WHERE tier=:t AND currency='krw' AND effective_to IS NULL"),
            {"t": tier},
        )
    ).first()
    assert row is not None, f"offering_version(tier={tier!r}, krw) 시드 없음"
    return row.id, row.included_seats


async def _seed_active_paid_subscription(session, org_id, *, tier="business", period_end=None):
    offering_id, _ = await _offering_id(session, tier)
    period_end = period_end or (datetime.now(timezone.utc) + timedelta(days=20))
    await session.execute(
        text(
            "INSERT INTO org_subscriptions "
            "(id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id, "
            " current_period_start, current_period_end) "
            "VALUES (:id, :org_id, :tier, 'monthly', 'active', 'krw', 'toss', :oid, :ps, :pe)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "tier": tier, "oid": offering_id, "ps": period_end - timedelta(days=10), "pe": period_end},
    )
    await session.commit()
    return period_end


async def _seed_human_member(session, org_id):
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x"))
    await session.flush()
    om_id = uuid.uuid4()
    session.add(OrgMember(id=om_id, org_id=org_id, user_id=user_id, role="member"))
    await session.flush()
    session.add(Member(id=om_id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    return om_id


@pytest.mark.anyio
async def test_cancel_subscription_does_not_change_tier_immediately_realdb():
    from app.services.org_subscription_downgrade import cancel_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_end = await _seed_active_paid_subscription(session, org_id, tier="business")

            sub = await cancel_subscription(session, org_id=org_id)

            assert sub.tier == "business", "즉시 전이 없음 — 현재 tier 유지"
            assert sub.pending_tier == "free"
            assert sub.pending_change_apply_at == period_end
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_subscription_rejects_non_active_paid_org_realdb():
    from app.services.org_subscription_downgrade import DowngradeError, cancel_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)  # 구독 행 자체가 없음(free, 시드 안 함)

            with pytest.raises(DowngradeError, match="활성 유료 구독이 아님"):
                await cancel_subscription(session, org_id=org_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_cancellation_clears_reservation_realdb():
    from app.services.org_subscription_downgrade import cancel_pending_downgrade, cancel_subscription

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="business")
            await cancel_subscription(session, org_id=org_id)

            sub = await cancel_pending_downgrade(session, org_id=org_id)

            assert sub.tier == "business"
            assert sub.pending_tier is None
            assert sub.pending_change_apply_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_applies_cancellation_to_free_at_period_end_realdb():
    from app.services.org_subscription_downgrade import cancel_subscription, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            past_period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(session, org_id, tier="starter", period_end=past_period_end)
            await _seed_human_member(session, org_id)  # 1명(free 3석 이내)

            await cancel_subscription(session, org_id=org_id)
            result = await sweep_pending_tier_downgrades(session)

            assert result["applied"] == 1
            assert result["cancelled_seat_overage"] == 0
            row = (
                await session.execute(
                    text("SELECT tier, status, billing_cycle, current_period_start, current_period_end, pending_tier FROM org_subscriptions WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.tier == "free"
            assert row.status == "active"
            assert row.billing_cycle is None
            assert row.current_period_start is None
            assert row.current_period_end is None
            assert row.pending_tier is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_cancellation_bypasses_seat_gate_and_blocks_new_seats_after_realdb():
    """⛔AC⑤ 핵심 — 선생님 확定: 취소는 좌석 초과를 이유로 거부되면 안 된다(해지 방해
    금지). free 포함좌석(3석)을 초과하는 6명 org가 취소하면 sweep이 그대로 free 전이를
    실행(자동 취소 아님)하고, 기존 멤버는 그대로 유지되며, 전이 後 신규 초대만
    check_member_invite_limit이 거부한다."""
    from app.services.org_subscription_downgrade import cancel_subscription, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            past_period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(session, org_id, tier="business", period_end=past_period_end)
            for _ in range(6):
                await _seed_human_member(session, org_id)

            _free_id, free_included_seats = await _offering_id(session, "free")
            assert 6 > free_included_seats, "이 테스트가 의미 있으려면 6명이 free 포함좌석을 초과해야 함"

            await cancel_subscription(session, org_id=org_id)
            result = await sweep_pending_tier_downgrades(session)

            # 좌석 게이트 미적용 — 자동 취소 0건, 실제 free 전이 실행.
            assert result["cancelled_seat_overage"] == 0
            assert result["applied"] == 1
            row = (
                await session.execute(text("SELECT tier FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})
            ).first()
            assert row.tier == "free"

            # 기존 멤버는 그대로.
            member_count = (
                await session.execute(text("SELECT COUNT(*) FROM org_members WHERE org_id=:oid AND deleted_at IS NULL"), {"oid": org_id})
            ).scalar_one()
            assert member_count == 6, "기존 멤버 강제 제거 없음"

            # 신규 좌석 추가만 차단 — check_member_invite_limit이 자연히 막는다(재구현 0).
            from fastapi import HTTPException

            from ee.plan_limits import check_member_invite_limit

            with pytest.raises(HTTPException) as exc_info:
                await check_member_invite_limit(session, org_id)
            assert exc_info.value.status_code == 402
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_downgrade_and_cancel_share_single_slot_last_wins_realdb():
    """⑥ — 하향 예약 후 취소하면(또는 그 반대) 같은 pending_* 슬롯을 덮어쓴다 — 새
    개념 발명 없이 #2881의 «재예약=덮어씀» 정책 그대로."""
    from app.services.org_subscription_downgrade import cancel_subscription, reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="business")

            await reserve_downgrade(session, org_id=org_id, new_tier="starter")
            sub = await cancel_subscription(session, org_id=org_id)
            assert sub.pending_tier == "free", "취소가 이전 하향 예약을 덮어써야 함"

            sub2 = await reserve_downgrade(session, org_id=org_id, new_tier="team")
            assert sub2.pending_tier == "team", "재하향이 이전 취소 예약을 덮어써야 함"
    finally:
        await engine.dispose()
