"""story #2880 — `prorate_minor` 순수함수 유닛테스트(카디르 비차단 권고, PR#3306 리뷰).

카디르+codex 뮤테이션 테스트가 `math.floor`→`round` 치환을 seed값(29000×2/3=19333.33)
에서 무감지 확認(19333이 floor·round 둘 다 같음 — 우연히 같은 값이 나오는 케이스였을
뿐, floor 자체가 틀렸다는 뜻은 아님). floor와 round가 실제로 갈리는 값으로 별도
검증해 "floor가 명시적으로 필요하다"는 계약을 직접 고정한다."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


def test_prorate_minor_floors_when_round_would_go_up():
    """price_minor=100·remaining/total=2/3 → 66.666... — floor=66, round()라면 67.
    round으로 뮤테이션되면 이 테스트가 즉시 잡는다(29000 seed와 달리 여기선 두 값이
    실제로 다르다)."""
    from app.services.billing_charge_amount import prorate_minor

    period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=30)  # 30일 주기
    now = period_start + timedelta(days=10)  # 잔여 20일 = 2/3

    result = prorate_minor(100, now=now, period_start=period_start, period_end=period_end)

    assert result == 66
    assert result != round(100 * 2 / 3)  # round면 67 — floor와 실제로 갈리는 지점


def test_prorate_minor_zero_remaining_at_period_start_returns_full_amount():
    period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=30)
    from app.services.billing_charge_amount import prorate_minor

    result = prorate_minor(9000, now=period_start, period_start=period_start, period_end=period_end)
    assert result == 9000  # 잔여 100% — 전액


def test_prorate_minor_at_period_end_raises_not_zero_silently():
    """잔여 0(now==period_end)은 "0을 반환"이 아니라 명시 실패 — 호출부가 그 자리를
    "부분취소 불필요"로 오인하지 않게(계산 불가와 0은 다른 사실)."""
    from app.services.billing_charge_amount import ChargeAmountError, prorate_minor

    period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=30)
    with pytest.raises(ChargeAmountError):
        prorate_minor(9000, now=period_end, period_start=period_start, period_end=period_end)


def test_prorate_minor_now_past_period_end_clamps_to_zero_remaining_and_raises():
    from app.services.billing_charge_amount import ChargeAmountError, prorate_minor

    period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    period_end = period_start + timedelta(days=30)
    with pytest.raises(ChargeAmountError):
        prorate_minor(9000, now=period_end + timedelta(days=1), period_start=period_start, period_end=period_end)


def test_prorate_minor_invalid_period_raises():
    from app.services.billing_charge_amount import ChargeAmountError, prorate_minor

    period_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(ChargeAmountError):
        prorate_minor(9000, now=period_start, period_start=period_start, period_end=period_start)  # total=0
