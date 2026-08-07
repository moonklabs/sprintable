"""결제②-D선행(story #2502) — Toss 구독 주기 계산. org_subscriptions.current_period_start/end
는 지금까지 Polar 웹훅 경로(ee/routers/billing.py)에서만 채워졌다 — Toss(원화) 구독은
이 필드를 세팅하는 경로가 아예 없었다(그라운딩 확認, 2026-08-07). 이 모듈은 그 계산만
진다(순수 함수) — 실제 세팅은 호출자(체크아웃 story #2506·향후 갱신 경로)가 한다.

⛔외부 의존성(dateutil 등) 추가 안 함 — 달력 월 연산은 순수 stdlib로 직접(이 레포에
python-dateutil이 pyproject에 선언돼 있지 않음 — 다른 패키지의 전이 의존성으로 우연히
설치돼 있을 뿐이라 신뢰 안 함)."""
from __future__ import annotations

import calendar
from datetime import datetime, timezone


def _add_months(dt: datetime, months: int) -> datetime:
    """dt에 개월 수를 더한다 — 말일 클램프(예: 1/31 + 1개월 → 2/28 또는 2/29, 31일이
    아니라)."""
    total_month_index = dt.month - 1 + months
    year = dt.year + total_month_index // 12
    month = total_month_index % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def compute_period_end(period_start: datetime, billing_cycle: str) -> datetime:
    """billing_cycle(monthly/annual)에 따라 period_start로부터 다음 결제일을 계산한다.
    프로레이션 없음(PO 확定 2026-08-07 — pricing-policy-v2-3, 연납=선납 전액·월할 없음) —
    +1개월/+1년 전체 기간."""
    if billing_cycle not in ("monthly", "annual"):
        raise ValueError(f"billing_cycle must be 'monthly' or 'annual', got {billing_cycle!r}")

    months = 1 if billing_cycle == "monthly" else 12
    return _add_months(period_start, months)


def new_subscription_period(*, now: datetime | None = None, billing_cycle: str) -> tuple[datetime, datetime]:
    """신규 구독/재구독 시점의 (current_period_start, current_period_end). start=지금."""
    now = now or datetime.now(timezone.utc)
    return now, compute_period_end(now, billing_cycle)
