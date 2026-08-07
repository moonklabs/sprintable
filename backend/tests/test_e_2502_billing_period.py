"""#2502 — Toss 구독 주기 계산(순수 함수). 프로레이션 없음(PO 확定) — +1개월/+1년 전체."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest


def test_compute_period_end_monthly():
    from app.services.billing_period import compute_period_end

    start = datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc)
    end = compute_period_end(start, "monthly")
    assert end == datetime(2026, 4, 15, 10, 0, tzinfo=timezone.utc)


def test_compute_period_end_annual():
    from app.services.billing_period import compute_period_end

    start = datetime(2026, 3, 15, 10, 0, tzinfo=timezone.utc)
    end = compute_period_end(start, "annual")
    assert end == datetime(2027, 3, 15, 10, 0, tzinfo=timezone.utc)


def test_compute_period_end_clamps_month_end_jan31_to_feb28():
    from app.services.billing_period import compute_period_end

    start = datetime(2026, 1, 31, 0, 0, tzinfo=timezone.utc)
    end = compute_period_end(start, "monthly")
    assert end == datetime(2026, 2, 28, 0, 0, tzinfo=timezone.utc)  # 2026 = 평년


def test_compute_period_end_clamps_to_leap_day():
    from app.services.billing_period import compute_period_end

    start = datetime(2028, 1, 31, 0, 0, tzinfo=timezone.utc)  # 2028 = 윤년
    end = compute_period_end(start, "monthly")
    assert end == datetime(2028, 2, 29, 0, 0, tzinfo=timezone.utc)


def test_compute_period_end_december_rolls_year():
    from app.services.billing_period import compute_period_end

    start = datetime(2026, 12, 20, tzinfo=timezone.utc)
    end = compute_period_end(start, "monthly")
    assert end == datetime(2027, 1, 20, tzinfo=timezone.utc)


@pytest.mark.parametrize("bogus", [None, "Monthly", "weekly", ""])
def test_compute_period_end_rejects_invalid_billing_cycle(bogus):
    from app.services.billing_period import compute_period_end

    with pytest.raises(ValueError, match="billing_cycle"):
        compute_period_end(datetime(2026, 1, 1, tzinfo=timezone.utc), bogus)


def test_new_subscription_period_start_is_now_and_end_is_computed():
    from app.services.billing_period import new_subscription_period

    now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    start, end = new_subscription_period(now=now, billing_cycle="monthly")
    assert start == now
    assert end == datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)
