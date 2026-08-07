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
# 호출 순서(#2509 가드 fix 後): ①order 조회 ②newer-confirmed-order 체크 ③newer-billing-key
# 체크 ④(회복증거 없을 때만)offering 조회 ⑤(동일)upsert ⑥order 종결 UPDATE.

def _stale_order_row(created_at):
    o = MagicMock()
    o.created_at = created_at
    return o


def _no_recovery_evidence_side_effects(order_created_at, free_offering):
    """회복 증거(더 나중 confirmed order·더 나중 발급 billing_key) 둘 다 없는 표준 경로."""
    order_result = MagicMock()
    order_result.scalar_one_or_none.return_value = _stale_order_row(order_created_at)
    confirmed_check = MagicMock()
    confirmed_check.first.return_value = None
    key_check = MagicMock()
    key_check.first.return_value = None
    offering_result = MagicMock()
    offering_result.scalar_one_or_none.return_value = free_offering
    upsert_result = MagicMock()
    close_order_result = MagicMock()
    return [order_result, confirmed_check, key_check, offering_result, upsert_result, close_order_result]


@pytest.mark.anyio
async def test_downgrade_to_free_upserts_free_tier(monkeypatch):
    from app.services.billing_scheduler import downgrade_to_free

    org_id = uuid.uuid4()
    order_id = "ord-downgrade-1"
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    free_offering = MagicMock()
    free_offering.id = uuid.uuid4()

    session = AsyncMock()
    session.execute = AsyncMock(
        side_effect=_no_recovery_evidence_side_effects(now - timedelta(days=9), free_offering)
    )
    session.commit = AsyncMock()

    await downgrade_to_free(session, org_id, order_id)

    upsert_call = session.execute.call_args_list[4]
    compiled = upsert_call.args[0].compile().params
    assert compiled["org_id"] == org_id
    assert compiled["tier"] == "free"
    assert compiled["offering_version_id"] == free_offering.id
    session.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_downgrade_to_free_handles_missing_offering_gracefully(monkeypatch):
    """free offering_version 시드가 없어도(방어) crash하지 않고 offering_version_id=None으로 진행."""
    from app.services.billing_scheduler import downgrade_to_free

    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    session = AsyncMock()
    session.execute = AsyncMock(
        side_effect=_no_recovery_evidence_side_effects(now - timedelta(days=9), None)
    )
    session.commit = AsyncMock()

    await downgrade_to_free(session, uuid.uuid4(), "ord-downgrade-2")

    upsert_call = session.execute.call_args_list[4]
    compiled = upsert_call.args[0].compile().params
    assert compiled["offering_version_id"] is None


@pytest.mark.anyio
async def test_downgrade_to_free_closes_the_order_po_blocker_fix(monkeypatch):
    """PO 리뷰 블로커(#2884, 2026-08-07) 회귀 고정 — "상태 자가회수 부재": order를
    'downgraded'(종결)로 전이시켜 failed-스윕 집합에서 영구히 뺀다. 이걸 안 하면(예전
    버그) ①매 스윕 재처리 ②org가 나중에 재구독해도 옛 failed order가 다시 골라져
    새 유료 구독을 free로 clobber — 둘 다 이 전이 하나로 막힌다."""
    from app.services.billing_scheduler import downgrade_to_free

    org_id = uuid.uuid4()
    order_id = "ord-downgrade-3"
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    session = AsyncMock()
    session.execute = AsyncMock(
        side_effect=_no_recovery_evidence_side_effects(now - timedelta(days=9), None)
    )
    session.commit = AsyncMock()

    await downgrade_to_free(session, org_id, order_id)

    # 마지막(6번째) 호출이 billing_orders를 'downgraded'로 닫는 UPDATE여야.
    close_call = session.execute.call_args_list[5]
    compiled = close_call.args[0].compile().params
    assert compiled["status"] == "downgraded"


@pytest.mark.anyio
async def test_downgrade_to_free_skips_upsert_when_newer_confirmed_order_exists_po_2509_fix():
    """카디르 결함사냥(#2509①) 회귀 고정 — "다른-order 재구독 클로버": 이 stale order보다
    나중에 confirmed된 order가 있으면(=이미 다른 경로로 재구독 성공) free upsert를
    건너뛴다. 재처리 방지 목적은 그대로 유지(order는 여전히 닫음)."""
    from app.services.billing_scheduler import downgrade_to_free

    org_id = uuid.uuid4()
    order_id = "ord-stale-1"
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)

    order_result = MagicMock()
    order_result.scalar_one_or_none.return_value = _stale_order_row(now - timedelta(days=9))
    confirmed_check = MagicMock()
    confirmed_check.first.return_value = (uuid.uuid4(),)  # 더 나중 confirmed order 존재
    key_check = MagicMock()
    key_check.first.return_value = None
    close_order_result = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[order_result, confirmed_check, key_check, close_order_result])
    session.commit = AsyncMock()

    await downgrade_to_free(session, org_id, order_id)

    # execute가 4번만 불렸다 = offering 조회·upsert가 스킵됐다(회복 증거로 free upsert 건너뜀).
    assert session.execute.await_count == 4
    close_call = session.execute.call_args_list[3]
    assert close_call.args[0].compile().params["status"] == "downgraded"


@pytest.mark.anyio
async def test_downgrade_to_free_skips_upsert_when_newly_issued_billing_key_exists():
    """order 생성 이후 새로 발급된 활성 billing_key가 있으면(재인증 진행 중 race
    윈도) 마찬가지로 free upsert를 건너뛴다."""
    from app.services.billing_scheduler import downgrade_to_free

    org_id = uuid.uuid4()
    order_id = "ord-stale-2"
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)

    order_result = MagicMock()
    order_result.scalar_one_or_none.return_value = _stale_order_row(now - timedelta(days=9))
    confirmed_check = MagicMock()
    confirmed_check.first.return_value = None
    key_check = MagicMock()
    key_check.first.return_value = (uuid.uuid4(),)  # 더 나중 발급된 활성 billing_key 존재
    close_order_result = MagicMock()

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[order_result, confirmed_check, key_check, close_order_result])
    session.commit = AsyncMock()

    await downgrade_to_free(session, org_id, order_id)

    assert session.execute.await_count == 4


@pytest.mark.anyio
async def test_downgrade_to_free_returns_early_when_order_missing():
    """order가 이미 존재하지 않으면(동시처리 등) 아무 것도 안 하고 조용히 리턴 —
    org_subscriptions를 건드리지 않는다."""
    from app.services.billing_scheduler import downgrade_to_free

    order_result = MagicMock()
    order_result.scalar_one_or_none.return_value = None
    session = AsyncMock()
    session.execute = AsyncMock(return_value=order_result)
    session.commit = AsyncMock()

    await downgrade_to_free(session, uuid.uuid4(), "ord-gone")

    assert session.execute.await_count == 1
    session.commit.assert_not_awaited()


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
    downgrade_mock.assert_awaited_once_with(session, downgrade_order.org_id, downgrade_order.order_id)


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

    assert result == {"stale_pending_seen": 1, "confirmed": 1, "failed": 0, "skipped_lookup_error": 0}
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

    assert result == {"stale_pending_seen": 1, "confirmed": 0, "failed": 1, "skipped_lookup_error": 0}
    confirm_mock.assert_not_awaited()
    fail_mock.assert_awaited_once()


@pytest.mark.anyio
async def test_sweep_stale_pending_leaves_pending_on_transient_lookup_error(monkeypatch):
    """PO fix-forward(#2884 리뷰) — 조회 자체가 실패(네트워크 등)한 것과 "Toss가 실패로
    안다"는 다른 신호다. 실제로는 성공했을 charge를 failed로 오분류하지 않도록, 조회
    예외는 order를 건드리지 않고 그냥 skip(다음 스윕이 재조회)."""
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
    confirm_mock = AsyncMock()
    monkeypatch.setattr(sched, "_mark_failed_if_not_confirmed", fail_mock)
    monkeypatch.setattr(sched, "_confirm_with_ledger", confirm_mock)

    result = await sched.sweep_stale_pending_orders(session, now=now)

    assert result == {"stale_pending_seen": 1, "confirmed": 0, "failed": 0, "skipped_lookup_error": 1}
    fail_mock.assert_not_awaited()
    confirm_mock.assert_not_awaited()


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
