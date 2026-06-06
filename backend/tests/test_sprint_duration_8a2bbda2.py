"""8a2bbda2: Sprint duration 을 start/end 날짜에서 산출(stored 14 오염 무시).

6/1~6/5 → 5d (이전 14d 오표기). dates 단일진실 — SprintResponse·analytics·create/update 일치.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from app.schemas.sprint import SprintResponse, compute_sprint_duration


def test_compute_duration_inclusive():
    assert compute_sprint_duration(date(2026, 6, 1), date(2026, 6, 5)) == 5   # 6/1~6/5 = 5d
    assert compute_sprint_duration(date(2026, 6, 1), date(2026, 6, 14)) == 14  # 기본 2주와 정합
    assert compute_sprint_duration(date(2026, 6, 1), date(2026, 6, 1)) == 1    # 당일


def test_compute_duration_fallback_when_dates_missing():
    assert compute_sprint_duration(None, date(2026, 6, 5), fallback=14) == 14
    assert compute_sprint_duration(date(2026, 6, 1), None, fallback=14) == 14
    assert compute_sprint_duration(None, None, fallback=7) == 7
    assert compute_sprint_duration(None, None) is None


def test_compute_duration_end_before_start_fallback():
    # end < start → 음수 방지·fallback
    assert compute_sprint_duration(date(2026, 6, 5), date(2026, 6, 1), fallback=14) == 14


def _resp_payload(**over):
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        title="S", status="active", duration=14,
        start_date=date(2026, 6, 1), end_date=date(2026, 6, 5),
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    base.update(over)
    return base


def test_sprint_response_derives_duration_from_dates():
    """stored duration=14 라도 날짜(6/1~6/5)면 응답 duration=5 (기존 sprint 백필 불요)."""
    r = SprintResponse.model_validate(_resp_payload())
    assert r.duration == 5


def test_sprint_response_uses_stored_when_no_dates():
    """날짜 없으면 stored duration 유지(파생 불가)."""
    r = SprintResponse.model_validate(_resp_payload(start_date=None, end_date=None, duration=10))
    assert r.duration == 10
