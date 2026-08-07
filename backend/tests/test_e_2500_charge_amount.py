"""#2500(청구②) — 청구액 계산 엔진. offering_version × 사람좌석 × 팩 → org 청구액.
PO 계약(2026-08-07): 좌석=사람만(org_members)·팩분=billing_ledger_entries 기간집계(현재는
트리거 없어 항상 0)·숫자는 offering_version에서(하드코딩 금지)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


def _subscription(*, billing_cycle="monthly", offering_version_id=None, period_start=None, period_end=None):
    sub = MagicMock()
    sub.id = uuid.uuid4()
    sub.org_id = uuid.uuid4()
    sub.billing_cycle = billing_cycle
    sub.offering_version_id = offering_version_id or uuid.uuid4()
    sub.current_period_start = period_start
    sub.current_period_end = period_end
    return sub


def _offering(
    *, tier="team", currency="krw", monthly=59_000, annual=590_000,
    included_seats=5, extra_seat_price_minor=11_000,
):
    o = MagicMock()
    o.id = uuid.uuid4()
    o.tier = tier
    o.currency = currency
    o.monthly_price_minor = monthly
    o.annual_price_minor = annual
    o.included_seats = included_seats
    o.extra_seat_price_minor = extra_seat_price_minor
    return o


def _exec_result(scalar_value):
    r = MagicMock()
    r.scalar_one.return_value = scalar_value
    r.scalar_one_or_none.return_value = scalar_value
    return r


# ─── count_human_seats ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_count_human_seats_queries_org_members_only():
    from app.services.billing_charge_amount import count_human_seats

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(3))

    count = await count_human_seats(session, org_id)

    assert count == 3
    compiled = session.execute.call_args.args[0].compile()
    assert "org_members" in str(compiled).lower()


# ─── compute_pack_charge_minor ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_compute_pack_charge_minor_zero_when_no_period_bounds():
    from app.services.billing_charge_amount import compute_pack_charge_minor

    session = AsyncMock()
    session.execute = AsyncMock()

    amount = await compute_pack_charge_minor(
        session, org_id=uuid.uuid4(), subscription_id=uuid.uuid4(),
        period_start=None, period_end=None,
    )

    assert amount == 0
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_compute_pack_charge_minor_sums_ledger_entries_in_period():
    from app.services.billing_charge_amount import compute_pack_charge_minor

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(15_000))
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)

    amount = await compute_pack_charge_minor(
        session, org_id=uuid.uuid4(), subscription_id=uuid.uuid4(),
        period_start=now - timedelta(days=30), period_end=now,
    )

    assert amount == 15_000
    session.execute.assert_awaited_once()


# ─── compute_charge_amount ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_compute_charge_amount_base_only_no_overage_no_packs():
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="monthly")
    offering = _offering(monthly=59_000, included_seats=5, extra_seat_price_minor=11_000)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(5)])
    session.get = AsyncMock(return_value=offering)

    amount, currency = await compute_charge_amount(session, org_id=org_id)

    assert amount == 59_000
    assert currency == "krw"


@pytest.mark.anyio
async def test_compute_charge_amount_uses_annual_price_for_annual_cycle():
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="annual")
    offering = _offering(monthly=59_000, annual=590_000, included_seats=5, extra_seat_price_minor=11_000)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(5)])
    session.get = AsyncMock(return_value=offering)

    amount, _ = await compute_charge_amount(session, org_id=org_id)

    assert amount == 590_000


@pytest.mark.anyio
async def test_compute_charge_amount_adds_seat_overage_at_extra_seat_price():
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="monthly")
    offering = _offering(tier="team", monthly=59_000, included_seats=5, extra_seat_price_minor=11_000)

    session = AsyncMock()
    # 5 included, 7 실좌석 → 2석 초과 * 11,000
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(7)])
    session.get = AsyncMock(return_value=offering)

    amount, _ = await compute_charge_amount(session, org_id=org_id)

    assert amount == 59_000 + 2 * 11_000


@pytest.mark.anyio
async def test_compute_charge_amount_business_tier_uses_its_own_extra_seat_price():
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="monthly")
    offering = _offering(tier="business", monthly=219_000, included_seats=15, extra_seat_price_minor=9_900)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(16)])
    session.get = AsyncMock(return_value=offering)

    amount, _ = await compute_charge_amount(session, org_id=org_id)

    assert amount == 219_000 + 1 * 9_900


@pytest.mark.anyio
async def test_compute_charge_amount_raises_when_starter_seat_overage_has_no_extra_seat_price():
    """Starter는 추가좌석을 팔지 않는다(정책) — 초과 상태는 상위 티어 전환 후에만 유효,
    이 계산기가 만나면 안 되는 불변식 위반이라 조용히 0으로 넘기지 않고 명시적으로 실패."""
    from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="monthly")
    offering = _offering(tier="starter", monthly=29_000, included_seats=3, extra_seat_price_minor=None)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(4)])
    session.get = AsyncMock(return_value=offering)

    with pytest.raises(ChargeAmountError, match="starter"):
        await compute_charge_amount(session, org_id=org_id)


@pytest.mark.anyio
async def test_compute_charge_amount_includes_pack_charge_when_period_bounds_set():
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    now = datetime(2026, 8, 15, tzinfo=timezone.utc)
    sub = _subscription(
        billing_cycle="monthly",
        period_start=now - timedelta(days=10), period_end=now,
    )
    offering = _offering(monthly=59_000, included_seats=5, extra_seat_price_minor=11_000)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(5), _exec_result(7_000)])
    session.get = AsyncMock(return_value=offering)

    amount, _ = await compute_charge_amount(session, org_id=org_id)

    assert amount == 59_000 + 7_000
    assert session.execute.await_count == 3


@pytest.mark.anyio
async def test_compute_charge_amount_pack_charge_zero_without_period_bounds():
    """current_period_start/end 미세팅(#2502 갭 — Toss 신규전환 진입점 아직 없음)이면 팩분
    집계 자체를 건너뛴다(추가 execute 호출 없음)."""
    from app.services.billing_charge_amount import compute_charge_amount

    org_id = uuid.uuid4()
    sub = _subscription(billing_cycle="monthly", period_start=None, period_end=None)
    offering = _offering(monthly=59_000, included_seats=5, extra_seat_price_minor=11_000)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(sub), _exec_result(5)])
    session.get = AsyncMock(return_value=offering)

    amount, _ = await compute_charge_amount(session, org_id=org_id)

    assert amount == 59_000
    assert session.execute.await_count == 2


@pytest.mark.anyio
async def test_compute_charge_amount_raises_when_no_subscription_row():
    from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(None))

    with pytest.raises(ChargeAmountError, match="no org_subscription"):
        await compute_charge_amount(session, org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_compute_charge_amount_raises_when_offering_version_id_is_none():
    from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount

    sub = _subscription()
    sub.offering_version_id = None
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(sub))

    with pytest.raises(ChargeAmountError, match="offering_version_id"):
        await compute_charge_amount(session, org_id=uuid.uuid4())


@pytest.mark.anyio
async def test_compute_charge_amount_raises_when_offering_version_dangling():
    """offering_version_id는 있는데 FK 대상 행이 없는(비정상) 상태 — 조용히 넘기지 않는다."""
    from app.services.billing_charge_amount import ChargeAmountError, compute_charge_amount

    sub = _subscription()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result(sub))
    session.get = AsyncMock(return_value=None)

    with pytest.raises(ChargeAmountError, match="찾을 수 없음"):
        await compute_charge_amount(session, org_id=uuid.uuid4())
