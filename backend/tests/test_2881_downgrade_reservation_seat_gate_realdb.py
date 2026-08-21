"""story #2881(결제 트랙 갭②) — 하향 예약 + 갱신일 좌석 게이트 실PG 검증. 순수 DB write
(Toss 호출 없음 — 하향은 즉시 charge/refund가 없다, v2.2 D10)라 TossAdapter mock도 불요.

커버:
  AC① — 하향 예약이 즉시 전이 없이 pending_*만 기록(현재 tier 무변화).
  AC② — sweep이 apply_at<=now인 예약만 적용(future는 skip).
  AC③ — 좌석초과 시 sweep이 하향을 자동 취소(pending_* 클리어) + 원 tier 유지(강제 제거 없음).
  AC④ — 예약 철회 엔드포인트 대신 서비스 직접 호출(cancel_pending_downgrade) — pending_*만 클리어.
  ⑤ — 상향/동일tier 방향은 DowngradeError(400 매핑 대상), free 대상도 거부.
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
            text("SELECT id FROM offering_versions WHERE tier=:t AND currency='krw' AND effective_to IS NULL"),
            {"t": tier},
        )
    ).first()
    assert row is not None, f"offering_version(tier={tier!r}, krw) 시드 없음"
    return row.id


async def _seed_active_paid_subscription(session, org_id, *, tier="business", period_end=None):
    offering_id = await _offering_id(session, tier)
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
async def test_reserve_downgrade_does_not_change_tier_immediately_realdb():
    from app.services.org_subscription_downgrade import reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            period_end = await _seed_active_paid_subscription(session, org_id, tier="business")

            sub = await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            assert sub.tier == "business"  # AC① 즉시 전이 없음
            assert sub.pending_tier == "starter"
            assert sub.pending_change_apply_at == period_end
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reserve_downgrade_overwrites_prior_reservation_realdb():
    from app.services.org_subscription_downgrade import reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="business")

            await reserve_downgrade(session, org_id=org_id, new_tier="team")
            sub = await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            assert sub.pending_tier == "starter"  # 단일 슬롯, 재예약이 이전 것을 덮어씀
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_pending_downgrade_clears_reservation_realdb():
    from app.services.org_subscription_downgrade import cancel_pending_downgrade, reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="business")
            await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            sub = await cancel_pending_downgrade(session, org_id=org_id)

            assert sub.pending_tier is None
            assert sub.pending_offering_version_id is None
            assert sub.pending_change_apply_at is None
            assert sub.tier == "business"  # AC④ 원 tier 무변화
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_applies_due_downgrade_and_rolls_period_realdb():
    """AC② — apply_at이 이미 지난 예약은 sweep이 적용하고 tier/period 둘 다 전이."""
    from app.services.org_subscription_downgrade import reserve_downgrade, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            past_period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(session, org_id, tier="business", period_end=past_period_end)
            await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            result = await sweep_pending_tier_downgrades(session)
            assert result["applied"] == 1
            assert result["cancelled_seat_overage"] == 0

            row = (
                await session.execute(
                    text("SELECT tier, pending_tier, pending_change_apply_at, current_period_start, current_period_end FROM org_subscriptions WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.tier == "starter"
            assert row.pending_tier is None
            assert row.pending_change_apply_at is None
            assert row.current_period_end > past_period_end  # 새 주기로 굴러감
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_skips_future_reservation_realdb():
    """AC② — apply_at이 아직 안 지난 예약은 이 sweep 실행에서 손대지 않는다."""
    from app.services.org_subscription_downgrade import reserve_downgrade, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            future_period_end = datetime.now(timezone.utc) + timedelta(days=5)
            await _seed_active_paid_subscription(session, org_id, tier="business", period_end=future_period_end)
            await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            result = await sweep_pending_tier_downgrades(session)
            assert result["pending_seen"] == 0  # 이 org는 apply_at 미도래라 대상에 안 들어옴

            row = (
                await session.execute(text("SELECT tier, pending_tier FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})
            ).first()
            assert row.tier == "business"
            assert row.pending_tier == "starter"  # 예약 그대로
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_auto_cancels_downgrade_on_seat_overage_no_forced_removal_realdb():
    """AC③ — starter는 좌석 3석(카탈로그). 4명 있는 org가 starter로 하향 예약 → sweep이
    자동 취소(pending_* 클리어) + business tier 유지 + 멤버 4명 그대로(강제 제거 없음)."""
    from app.services.org_subscription_downgrade import reserve_downgrade, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            past_period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(session, org_id, tier="business", period_end=past_period_end)
            for _ in range(4):
                await _seed_human_member(session, org_id)

            included_seats_starter = (
                await session.execute(text("SELECT included_seats FROM offering_versions WHERE tier='starter' AND currency='krw' AND effective_to IS NULL"))
            ).scalar_one()
            assert included_seats_starter < 4, "이 테스트가 의미 있으려면 starter included_seats < 4명이어야 함(카탈로그 확認)"

            await reserve_downgrade(session, org_id=org_id, new_tier="starter")
            result = await sweep_pending_tier_downgrades(session)

            assert result["cancelled_seat_overage"] == 1
            assert result["applied"] == 0

            row = (
                await session.execute(
                    text("SELECT tier, pending_tier, pending_change_apply_at FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id},
                )
            ).first()
            assert row.tier == "business"  # 원 tier 유지(자동 취소)
            assert row.pending_tier is None

            member_count = (
                await session.execute(text("SELECT COUNT(*) FROM org_members WHERE org_id=:oid AND deleted_at IS NULL"), {"oid": org_id})
            ).scalar_one()
            assert member_count == 4  # 강제 제거 없음
    finally:
        await engine.dispose()


async def _seed_owner_member(session, org_id, *, email):
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=email, hashed_password="x"))
    await session.flush()
    om_id = uuid.uuid4()
    session.add(OrgMember(id=om_id, org_id=org_id, user_id=user_id, role="owner"))
    await session.flush()
    session.add(Member(id=om_id, org_id=org_id, type="human", user_id=user_id, name="Owner"))
    await session.commit()
    return om_id


@pytest.mark.anyio
async def test_sweep_auto_cancel_email_content_shows_real_tier_not_none_realdb():
    """카디르 확定 버그(PR#3308 QA, 2026-08-21) 회귀 고정 — 좌석초과 자동취소 알림
    이메일이 raw UPDATE 直後 `sub.pending_tier`를 읽어(SQLAlchemy Core update()의
    evaluate synchronize_session이 in-session 객체를 이미 None으로 동기화한 뒤라)
    항상 "Plan downgrade to None was cancelled"로 발송됐다. 기존 8건은 DB 상태만
    확認하고 메일 CONTENT는 전혀 assert하지 않아 이 결함을 놓쳤다 — 여기서 실제
    발송 인자(subject/html)에 tier명("starter")이 정확히 들어가는지 직접 확認한다."""
    from app.services.org_subscription_downgrade import reserve_downgrade, sweep_pending_tier_downgrades

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            past_period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(session, org_id, tier="business", period_end=past_period_end)
            await _seed_owner_member(session, org_id, email="owner@2881-email-content.test")
            for _ in range(4):
                await _seed_human_member(session, org_id)

            included_seats_starter = (
                await session.execute(text("SELECT included_seats FROM offering_versions WHERE tier='starter' AND currency='krw' AND effective_to IS NULL"))
            ).scalar_one()
            assert included_seats_starter < 5, "이 테스트가 의미 있으려면 starter included_seats < 5명(owner 포함)이어야 함"

            await reserve_downgrade(session, org_id=org_id, new_tier="starter")

            sent = []
            with pytest.MonkeyPatch.context() as mp:
                mp.setattr(
                    "app.services.org_subscription_downgrade.send_email",
                    lambda to, subject, html: sent.append((to, subject, html)),
                )
                result = await sweep_pending_tier_downgrades(session)

            assert result["cancelled_seat_overage"] == 1
            assert len(sent) == 1, "owner 1명 — 메일 정확히 1건"
            to, subject, html = sent[0]
            assert to == "owner@2881-email-content.test"
            assert "None" not in subject, f"tier명이 None으로 새는 회귀 — subject={subject!r}"
            assert "None" not in html, f"tier명이 None으로 새는 회귀 — html={html!r}"
            assert "starter" in subject
            assert "starter" in html
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upgrade_direction_rejected_by_downgrade_endpoint_realdb():
    """⑤ — starter→team(상향 방향)을 이 서비스로 넣으면 거부(하향 전용)."""
    from app.services.org_subscription_downgrade import DowngradeError, reserve_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="starter")

            with pytest.raises(DowngradeError, match="하향이 아님"):
                await reserve_downgrade(session, org_id=org_id, new_tier="team")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_without_pending_reservation_rejected_realdb():
    from app.services.org_subscription_downgrade import DowngradeError, cancel_pending_downgrade

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org(session)
            await _seed_active_paid_subscription(session, org_id, tier="starter")

            with pytest.raises(DowngradeError, match="철회할 예약된 하향이 없음"):
                await cancel_pending_downgrade(session, org_id=org_id)
    finally:
        await engine.dispose()
