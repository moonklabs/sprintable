"""#2494(C3) — dunning 재시도 상태기계(pricing-policy-proposal-v1 §12.1) + pending 대사.
PO 계약(2026-08-07): (b)-narrowed — "신규 결제 주기 도래" 판정은 스코프 밖(#2502 대기)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


def _order(*, status: str, created_days_ago: int, updated_days_ago: int, now: datetime):
    o = MagicMock()
    o.status = status
    o.created_at = now - timedelta(days=created_days_ago)
    o.updated_at = now - timedelta(days=updated_days_ago)
    o.org_id = uuid.uuid4()
    o.order_id = f"ord-{uuid.uuid4()}"
    o.amount_minor = 29000
    o.currency = "krw"
    return o


# ─── next_dunning_action — 순수 함수(§12.1 케이던스) ───────────────────────

@pytest.mark.parametrize(
    "status,age_days,updated_days_ago,expected",
    [
        ("confirmed", 3, 3, "wait"),          # confirmed는 애초에 대상 아님
        ("pending", 3, 3, "wait"),             # pending도 dunning 대상 아님(대사 몫)
        ("failed", 0, 0, "wait"),              # 최초 실패 당일 — §12.1 "기능 유지"만, 재시도 없음
        ("failed", 1, 1, "retry"),             # +1일 1차 재결제
        ("failed", 2, 2, "wait"),              # +2일 — 케이던스에 없는 날
        ("failed", 3, 3, "retry"),             # +3일 2차
        ("failed", 5, 5, "retry"),             # +5일 3차
        ("failed", 7, 7, "wait"),              # +7일 = 유예종료 "알림"이지 재시도 아님
        ("failed", 8, 7, "downgrade_to_free"), # +8일 Free 전환
        ("failed", 10, 7, "downgrade_to_free"),# 8일 지나면 계속 downgrade(멱등)
    ],
)
def test_next_dunning_action_follows_policy_cadence(status, age_days, updated_days_ago, expected):
    from app.services.billing_scheduler import next_dunning_action

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    order = _order(status=status, created_days_ago=age_days, updated_days_ago=updated_days_ago, now=now)
    assert next_dunning_action(order, now=now) == expected


def test_next_dunning_action_same_day_retry_not_repeated():
    """cron이 하루에 여러 번 돌아도(*/10분 등) 이미 오늘 시도한 order는 또 재시도하지 않는다."""
    from app.services.billing_scheduler import next_dunning_action

    now = datetime(2026, 8, 15, 14, 0, tzinfo=timezone.utc)
    order = _order(status="failed", created_days_ago=1, updated_days_ago=0, now=now)  # 오늘 이미 갱신됨
    assert next_dunning_action(order, now=now) == "wait"


# ─── downgrade_to_free ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_downgrade_to_free_upserts_free_tier(monkeypatch):
    from app.services.billing_scheduler import downgrade_to_free

    org_id = uuid.uuid4()
    free_offering = MagicMock()
    free_offering.id = uuid.uuid4()

    session = AsyncMock()
    offering_result = MagicMock()
    offering_result.scalar_one_or_none.return_value = free_offering
    upsert_result = MagicMock()
    session.execute = AsyncMock(side_effect=[offering_result, upsert_result])
    session.commit = AsyncMock()

    await downgrade_to_free(session, org_id)

    upsert_call = session.execute.call_args_list[1]
    compiled = upsert_call.args[0].compile().params
    assert compiled["org_id"] == org_id
    assert compiled["tier"] == "free"
    assert compiled["offering_version_id"] == free_offering.id
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_downgrade_to_free_handles_missing_offering_gracefully(monkeypatch):
    """free offering_version 시드가 없어도(방어) crash하지 않고 offering_version_id=None으로 진행."""
    from app.services.billing_scheduler import downgrade_to_free

    session = AsyncMock()
    offering_result = MagicMock()
    offering_result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(side_effect=[offering_result, MagicMock()])
    session.commit = AsyncMock()

    await downgrade_to_free(session, uuid.uuid4())

    upsert_call = session.execute.call_args_list[1]
    compiled = upsert_call.args[0].compile().params
    assert compiled["offering_version_id"] is None


# ─── sweep_dunning_retries ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_sweep_dunning_retries_retries_and_downgrades(monkeypatch):
    import app.services.billing_scheduler as sched

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    retry_order = _order(status="failed", created_days_ago=1, updated_days_ago=1, now=now)
    downgrade_order = _order(status="failed", created_days_ago=9, updated_days_ago=8, now=now)
    wait_order = _order(status="failed", created_days_ago=2, updated_days_ago=2, now=now)

    session = AsyncMock()
    orders_result = MagicMock()
    orders_result.scalars.return_value.all.return_value = [retry_order, downgrade_order, wait_order]
    session.execute = AsyncMock(return_value=orders_result)

    charge_mock = AsyncMock()
    downgrade_mock = AsyncMock()
    monkeypatch.setattr(sched, "charge_org", charge_mock)
    monkeypatch.setattr(sched, "downgrade_to_free", downgrade_mock)

    result = await sched.sweep_dunning_retries(session, now=now)

    assert result == {"failed_orders_seen": 3, "retried": 1, "downgraded": 1}
    charge_mock.assert_awaited_once_with(
        session, org_id=retry_order.org_id, order_id=retry_order.order_id,
        amount_minor=retry_order.amount_minor, currency=retry_order.currency,
    )
    downgrade_mock.assert_awaited_once_with(session, downgrade_order.org_id)


@pytest.mark.anyio
async def test_sweep_dunning_retries_charge_exception_does_not_abort_sweep(monkeypatch):
    """한 order의 재시도가 예외를 던져도(charge_org가 내부에서 이미 failed로 기록했을
    것이므로) 스윕 전체가 죽지 않고 카운트만 반영한다."""
    import app.services.billing_scheduler as sched

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    retry_order = _order(status="failed", created_days_ago=1, updated_days_ago=1, now=now)

    session = AsyncMock()
    orders_result = MagicMock()
    orders_result.scalars.return_value.all.return_value = [retry_order]
    session.execute = AsyncMock(return_value=orders_result)

    monkeypatch.setattr(sched, "charge_org", AsyncMock(side_effect=RuntimeError("toss down")))
    monkeypatch.setattr(sched, "downgrade_to_free", AsyncMock())

    result = await sched.sweep_dunning_retries(session, now=now)
    assert result["retried"] == 1


# ─── sweep_stale_pending_orders ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_sweep_stale_pending_confirms_when_toss_lookup_done(monkeypatch):
    import app.services.billing_scheduler as sched

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    stale_order = _order(status="pending", created_days_ago=1, updated_days_ago=1, now=now)

    session = AsyncMock()
    orders_result = MagicMock()
    orders_result.scalars.return_value.all.return_value = [stale_order]
    session.execute = AsyncMock(return_value=orders_result)

    monkeypatch.setattr(
        sched.TossAdapter, "get_payment_by_order_id",
        AsyncMock(return_value={"status": "DONE", "paymentKey": "pay_recovered"}),
    )
    confirm_mock = AsyncMock()
    fail_mock = AsyncMock()
    monkeypatch.setattr(sched, "_confirm_with_ledger", confirm_mock)
    monkeypatch.setattr(sched, "_mark_failed_if_not_confirmed", fail_mock)

    result = await sched.sweep_stale_pending_orders(session, now=now)

    assert result == {"stale_pending_seen": 1, "confirmed": 1, "failed": 0}
    confirm_mock.assert_awaited_once_with(
        session, org_id=stale_order.org_id, order_id=stale_order.order_id,
        amount_minor=stale_order.amount_minor, currency=stale_order.currency,
        payment_key="pay_recovered",
    )
    fail_mock.assert_not_awaited()


@pytest.mark.anyio
async def test_sweep_stale_pending_marks_failed_when_toss_lookup_not_done(monkeypatch):
    import app.services.billing_scheduler as sched

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    stale_order = _order(status="pending", created_days_ago=1, updated_days_ago=1, now=now)

    session = AsyncMock()
    orders_result = MagicMock()
    orders_result.scalars.return_value.all.return_value = [stale_order]
    session.execute = AsyncMock(return_value=orders_result)

    monkeypatch.setattr(
        sched.TossAdapter, "get_payment_by_order_id",
        AsyncMock(return_value={"status": "ABORTED"}),
    )
    confirm_mock = AsyncMock()
    fail_mock = AsyncMock()
    monkeypatch.setattr(sched, "_confirm_with_ledger", confirm_mock)
    monkeypatch.setattr(sched, "_mark_failed_if_not_confirmed", fail_mock)

    result = await sched.sweep_stale_pending_orders(session, now=now)

    assert result == {"stale_pending_seen": 1, "confirmed": 0, "failed": 1}
    confirm_mock.assert_not_awaited()
    fail_mock.assert_awaited_once()


@pytest.mark.anyio
async def test_sweep_stale_pending_marks_failed_when_lookup_errors(monkeypatch):
    import app.services.billing_scheduler as sched

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    stale_order = _order(status="pending", created_days_ago=1, updated_days_ago=1, now=now)

    session = AsyncMock()
    orders_result = MagicMock()
    orders_result.scalars.return_value.all.return_value = [stale_order]
    session.execute = AsyncMock(return_value=orders_result)

    monkeypatch.setattr(
        sched.TossAdapter, "get_payment_by_order_id",
        AsyncMock(side_effect=RuntimeError("Cannot reach Toss API")),
    )
    fail_mock = AsyncMock()
    monkeypatch.setattr(sched, "_mark_failed_if_not_confirmed", fail_mock)
    monkeypatch.setattr(sched, "_confirm_with_ledger", AsyncMock())

    result = await sched.sweep_stale_pending_orders(session, now=now)

    assert result["failed"] == 1
    fail_mock.assert_awaited_once()


# ─── trigger_due_charges — 명시 스코프 밖 ───────────────────────────────────

@pytest.mark.anyio
async def test_trigger_due_charges_not_implemented_pending_story_2502():
    from app.services.billing_scheduler import trigger_due_charges

    with pytest.raises(NotImplementedError, match="#2502"):
        await trigger_due_charges(AsyncMock())


# ─── cron endpoint ───────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_toss_billing_maintenance_cron_requires_verify_cron(monkeypatch):
    """다른 cron 엔드포인트와 동일 인증 관례(verify_cron) — CRON_SECRET 불일치면 거부.
    #2072 교훈: CRON_SECRET 미설정 시 로컬 dev는 fail-open이라(is_really_local) 그 분기를
    피하려면 실제 시크릿을 명시로 설정해야 진짜 검증 경로를 태운다."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from tests.conftest import override_db_and_read

    monkeypatch.setattr("app.routers.cron.CRON_SECRET", "real-secret")

    async def _override_db():
        yield AsyncMock()

    override_db_and_read(app, _override_db)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get(
                "/api/v2/internal/cron/toss-billing-maintenance",
                headers={"Authorization": "Bearer wrong-secret"},
            )
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code in (401, 403)
