"""story #2907(선생님 확定 2026-08-21) — 결제 실패 dunning 실PG 검증.

grace 7일(어드민 관리값, platform_settings.dunning_grace_days) — 갱신 charge 실패 시
org_subscriptions.status='active'→'past_due', 매일 1회 재시도(D+1..D+grace_days), 매
실패마다 owner 메일, 성공 시 원 주기 유지+active 복귀, grace 만료(D+grace_days+1) 시
free 전이(기존 데이터 유지).

커버:
  AC1: 갱신 charge 실패 → active→past_due.
  AC2: 재시도 스윕 — 같은 날 중복 재시도 금지(멱등) + 성공 시 원 주기 유지+active 복귀.
  AC3: 실패 통보 메일 — 매 실패마다, 문안에 grace 만료일+제한 방식 명시.
  AC4: grace 만료 실패 시 free 전이 — 데이터 삭제 없음(tier=free/status=active).
  AC6: dunning_grace_days가 하드코딩이 아니라 실제로 판단을 바꾼다(load-bearing).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


@pytest.fixture(autouse=True)
def _crypto_key(monkeypatch):
    import app.core.config as config_module
    from app.services import billing_key_crypto

    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", "W3x6lXDky6UQE36FyRU_Snf9m7d73Aev59D4PvS4-N0=")
    billing_key_crypto._get_multi_fernet.cache_clear()
    yield
    billing_key_crypto._get_multi_fernet.cache_clear()


async def _seed_org_with_owner(session, *, email):
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :name, :slug, 'free')"),
        {"id": org_id, "name": f"test-org-{org_id}", "slug": f"slug-{org_id}"},
    )
    await session.execute(
        text(
            "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
            "login_fail_count,totp_enabled,totp_fail_count) VALUES "
            "(:id,:email,'x','Owner',true,true,0,false,0)"
        ),
        {"id": user_id, "email": email},
    )
    await session.execute(
        text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :org_id, :uid, 'owner')"),
        {"id": uuid.uuid4(), "org_id": org_id, "uid": user_id},
    )
    await session.commit()
    return org_id


async def _offering(session, tier):
    row = (
        await session.execute(
            text("SELECT id, monthly_price_minor FROM offering_versions WHERE tier=:t AND currency='krw' AND effective_to IS NULL"),
            {"t": tier},
        )
    ).first()
    assert row is not None, f"offering_version(tier={tier!r}, krw) 시드 없음"
    return row.id, row.monthly_price_minor


async def _seed_active_paid_subscription(session, org_id, *, tier, offering_id, period_start, period_end, status="active"):
    await session.execute(
        text(
            "INSERT INTO org_subscriptions "
            "(id, org_id, tier, billing_cycle, status, currency, provider, offering_version_id, "
            " current_period_start, current_period_end) "
            "VALUES (:id, :org_id, :tier, 'monthly', :status, 'krw', 'toss', :oid, :ps, :pe)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "tier": tier, "status": status, "oid": offering_id, "ps": period_start, "pe": period_end},
    )
    await session.commit()


async def _seed_active_billing_key(session, org_id):
    from app.services.billing_key_crypto import encrypt_billing_key

    await session.execute(
        text(
            "INSERT INTO org_billing_keys (id, org_id, customer_key, encrypted_billing_key, status, issued_at) "
            "VALUES (:id, :org_id, :ck, :ebk, 'active', now())"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "ck": f"org-{org_id}", "ebk": encrypt_billing_key("plaintext-billing-key-test")},
    )
    await session.commit()


async def _seed_renewal_failed_order(session, org_id, offering_id, period_end, *, created_at):
    from app.services.billing_scheduler import _renewal_order_id

    order_id = _renewal_order_id(org_id, offering_id, period_end)
    await session.execute(
        text(
            "INSERT INTO billing_orders (id, org_id, order_id, amount_minor, currency, status, created_at, updated_at) "
            "VALUES (:id, :org_id, :oid, 100000, 'krw', 'failed', :ca, :ca)"
        ),
        {"id": uuid.uuid4(), "org_id": org_id, "oid": order_id, "ca": created_at},
    )
    await session.commit()
    return order_id


async def _set_grace_days(session, days):
    await session.execute(text("UPDATE platform_settings SET dunning_grace_days = :d"), {"d": days})
    await session.commit()


@pytest.mark.anyio
async def test_trigger_due_charges_success_rolls_period_forward_stays_active_realdb():
    from app.services.billing_scheduler import trigger_due_charges

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner1@2907.test")
            offering_id, price = await _offering(session, "starter")
            period_start = datetime.now(timezone.utc) - timedelta(days=30)
            period_end = datetime.now(timezone.utc) - timedelta(hours=1)  # 이미 도래
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id, period_start=period_start, period_end=period_end,
            )
            await _seed_active_billing_key(session, org_id)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": price},
            )):
                result = await trigger_due_charges(session)

            # CI는 전체 pytest 스위트를 한 공유 실PG에서 돌린다 — trigger_due_charges는
            # org_subscriptions 전체를 스캔하므로 다른(무관한) 테스트가 남긴 active+과거
            # period_end 행도 함께 집혀 집계 카운트를 오염시킬 수 있다(로컬 파일단위 프레시
            # DB에서는 안 드러남). 집계는 하한만, 실제 판정은 이 org 자신의 row로.
            assert result["charged"] >= 1
            row = (
                await session.execute(
                    text("SELECT status, current_period_start, current_period_end FROM org_subscriptions WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.status == "active"
            assert row.current_period_start == period_end  # 원 도래일이 새 시작일
            assert row.current_period_end > period_end + timedelta(days=29)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_trigger_due_charges_failure_sets_past_due_and_notifies_realdb():
    from app.services.payment.toss_adapter import TossApiError
    from app.services.billing_scheduler import trigger_due_charges

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner2@2907.test")
            offering_id, price = await _offering(session, "starter")
            period_end = datetime.now(timezone.utc) - timedelta(hours=1)
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=period_end - timedelta(days=30), period_end=period_end,
            )
            await _seed_active_billing_key(session, org_id)

            sent = []
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=TossApiError("CARD_DECLINED", "카드 거절", status_code=400),
            )), patch("app.services.billing_scheduler.send_email", new=lambda to, subj, body: sent.append((to, subj, body))):
                result = await trigger_due_charges(session)

            # 공유 CI DB 오염 가능성 — 하한만(row-level이 실 판정).
            assert result["failed"] >= 1
            row = (await session.execute(text("SELECT status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})).first()
            assert row.status == "past_due"

            own_emails = [s for s in sent if s[0] == "owner2@2907.test"]
            assert len(own_emails) == 1
            to, subject, body = own_emails[0]
            grace_expires = (datetime.now(timezone.utc).date() + timedelta(days=7)).strftime("%Y-%m-%d")
            assert grace_expires in body, "메일 문안에 grace 만료일(언제)이 없음"
            assert "삭제되지 않" in body, "메일 문안에 데이터 미삭제(어떻게) 명시가 없음"
            assert "Free" in body or "free" in body, "메일 문안에 free 전이(어떻게) 명시가 없음"
            # fast-follow(유나양 design 비차단 권고, 2026-08-21) — ①raw enum 아닌 표시명 ②billing CTA 링크.
            assert "Starter" in body, "tier가 raw enum('starter')이 아니라 표시명('Starter')이어야 함"
            assert "/settings?tab=billing" in body, "billing 페이지 CTA 링크가 없음"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_trigger_due_charges_grace_anchor_is_order_created_at_not_now_realdb():
    """fast-follow(유나양 design 비차단 권고④, 2026-08-21) — trigger_due_charges의
    최초 실패 메일이 말하는 grace 만료일은 `order.created_at`(DB 타임스탬프) 기준이어야
    한다, 호출부의 파이썬 `now` 변수 기준이 아니다 — 둘이 갈리면(자정 근처 등)
    이 메일과 이후 sweep_dunning_retries 재시도 메일(이미 `order.created_at` 기준,
    `_sync_renewal_retry_outcome`)이 서로 다른 날짜를 말하게 된다. `now`를 실제
    DB commit 시각보다 훨씬 과거로 넘겨 검증(달랐다면 이 테스트가 그 차이를 드러낸다)."""
    from app.services.billing_scheduler import trigger_due_charges
    from app.services.payment.toss_adapter import TossApiError

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner7@2907.test")
            offering_id, price = await _offering(session, "starter")
            stale_now = datetime.now(timezone.utc) - timedelta(days=3)  # order.created_at(진짜 DB now())과 의도적으로 갈림
            period_end = stale_now - timedelta(hours=1)  # stale_now 기준으로도 이미 도래
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=period_end - timedelta(days=30), period_end=period_end,
            )
            await _seed_active_billing_key(session, org_id)

            sent = []
            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                side_effect=TossApiError("CARD_DECLINED", "카드 거절", status_code=400),
            )), patch("app.services.billing_scheduler.send_email", new=lambda to, subj, body: sent.append((to, subj, body))):
                await trigger_due_charges(session, now=stale_now)

            order_created_at = (
                await session.execute(text("SELECT created_at FROM billing_orders WHERE org_id=:oid"), {"oid": org_id})
            ).scalar_one()
            expected = (order_created_at.date() + timedelta(days=7)).strftime("%Y-%m-%d")
            unexpected = (stale_now.date() + timedelta(days=7)).strftime("%Y-%m-%d")
            assert expected != unexpected, "이 테스트가 의미 있으려면 두 anchor가 실제로 갈려야 함"

            assert len(sent) == 1
            body = sent[0][2]
            assert expected in body, f"메일이 order.created_at 앵커({expected})가 아니라 다른 값을 씀 — body={body!r}"
            assert unexpected not in body, "메일이 여전히 (스테일)now 앵커를 쓰고 있음 — 회귀"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_dunning_retry_success_restores_active_from_original_due_date_realdb():
    """AC2 — 재결제 성공 시 «원 주기 유지»: D+3에 성공해도 새 period_start는 원래
    도래했어야 할 날짜(D+0)를 기준으로 계산돼야 한다(늦게 성공했다고 유예일을 공짜로
    더 받지 않음)."""
    from app.services.billing_scheduler import sweep_dunning_retries

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner3@2907.test")
            offering_id, price = await _offering(session, "starter")
            original_due = datetime.now(timezone.utc) - timedelta(days=3, hours=1)
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=original_due - timedelta(days=30), period_end=original_due, status="past_due",
            )
            await _seed_active_billing_key(session, org_id)
            failed_created_at = datetime.now(timezone.utc) - timedelta(days=3)
            await _seed_renewal_failed_order(session, org_id, offering_id, original_due, created_at=failed_created_at)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=AsyncMock(
                return_value={"paymentKey": f"pay-{uuid.uuid4()}", "totalAmount": price},
            )):
                result = await sweep_dunning_retries(session)

            assert result["retried"] >= 1  # 공유 CI DB 오염 가능성 — 하한만.
            row = (
                await session.execute(
                    text("SELECT status, current_period_start, current_period_end FROM org_subscriptions WHERE org_id=:oid"),
                    {"oid": org_id},
                )
            ).first()
            assert row.status == "active"
            assert row.current_period_start == original_due
            assert row.current_period_end > original_due + timedelta(days=29)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_dunning_retry_daily_dedup_no_double_attempt_same_day_realdb():
    from app.services.billing_scheduler import sweep_dunning_retries

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner4@2907.test")
            offering_id, price = await _offering(session, "starter")
            original_due = datetime.now(timezone.utc) - timedelta(days=1, hours=1)
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=original_due - timedelta(days=30), period_end=original_due, status="past_due",
            )
            await _seed_active_billing_key(session, org_id)
            order_id = await _seed_renewal_failed_order(session, org_id, offering_id, original_due, created_at=original_due)

            call_count = 0

            async def _fake_post(self, path, **kwargs):
                nonlocal call_count
                call_count += 1
                from app.services.payment.toss_adapter import TossApiError
                raise TossApiError("CARD_DECLINED", "카드 거절", status_code=400)

            with patch("app.services.payment.toss_adapter.TossAdapter._post", new=_fake_post):
                await sweep_dunning_retries(session)
                updated_at_after_r1 = (
                    await session.execute(text("SELECT updated_at FROM billing_orders WHERE order_id=:oid"), {"oid": order_id})
                ).scalar_one()
                assert updated_at_after_r1.date() == datetime.now(timezone.utc).date(), "1차 스윕에서 이 order가 오늘 날짜로 재시도됐어야 함"

                await sweep_dunning_retries(session)

            # 공유 CI DB에 다른 org의 재시도가 섞여도, «이 order 자신»은 두 번째 스윕에서
            # 손대지지 않아야 한다(같은 날 dedup) — 전역 call_count/retried 집계가 아니라
            # 이 order 고유 updated_at의 불변으로 검증(다른 org의 Toss 콜과 무관).
            updated_at_after_r2 = (
                await session.execute(text("SELECT updated_at FROM billing_orders WHERE order_id=:oid"), {"oid": order_id})
            ).scalar_one()
            assert updated_at_after_r2 == updated_at_after_r1, "같은 날 두 번째 스윕이 이 order를 다시 건드리면 안 됨(멱등)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweep_dunning_downgrade_to_free_after_grace_expires_realdb():
    """AC4 — grace 만료(D+grace_days+1) 시 free 전이. 데이터 삭제 없음(tier=free만 되돌림,
    이 스윕은 다른 리소스 테이블을 안 건드린다 — downgrade_to_free 자체가 기존 검증됨)."""
    from app.services.billing_scheduler import sweep_dunning_retries

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            org_id = await _seed_org_with_owner(session, email="owner5@2907.test")
            offering_id, price = await _offering(session, "starter")
            original_due = datetime.now(timezone.utc) - timedelta(days=8, hours=1)
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=original_due - timedelta(days=30), period_end=original_due, status="past_due",
            )
            await _seed_renewal_failed_order(session, org_id, offering_id, original_due, created_at=original_due)

            result = await sweep_dunning_retries(session)

            assert result["downgraded"] >= 1  # 공유 CI DB 오염 가능성 — 하한만.
            row = (
                await session.execute(text("SELECT tier, status FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})
            ).first()
            assert row.tier == "free"
            assert row.status == "active"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_dunning_grace_days_platform_setting_changes_retry_window_realdb():
    """AC6 load-bearing — grace_days를 3으로 바꾸면 D+4가 (D+7이 아니라) downgrade
    트리거일이 돼야 한다. 하드코딩이었다면 이 테스트는 downgraded==0으로 실패한다."""
    from app.services.billing_scheduler import sweep_dunning_retries

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            await _set_grace_days(session, 3)
            org_id = await _seed_org_with_owner(session, email="owner6@2907.test")
            offering_id, price = await _offering(session, "starter")
            original_due = datetime.now(timezone.utc) - timedelta(days=4, hours=1)
            await _seed_active_paid_subscription(
                session, org_id, tier="starter", offering_id=offering_id,
                period_start=original_due - timedelta(days=30), period_end=original_due, status="past_due",
            )
            await _seed_renewal_failed_order(session, org_id, offering_id, original_due, created_at=original_due)

            result = await sweep_dunning_retries(session)

            assert result["downgraded"] >= 1, "grace_days=3이면 D+4는 downgrade여야 함(D+8이 아님)"
            row = (await session.execute(text("SELECT tier FROM org_subscriptions WHERE org_id=:oid"), {"oid": org_id})).first()
            assert row.tier == "free"
    finally:
        await engine.dispose()
