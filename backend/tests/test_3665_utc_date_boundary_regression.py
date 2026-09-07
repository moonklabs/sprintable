"""story #3665(BE·결함, 페드루 PO CHANGES 2026-09-07) — `standups.py:308`의 원 결함
(`date.today()`=프로세스 로컬 타임존 기준이라 배포 컨테이너 시스템 TZ가 UTC가 아니면
"오늘" 계산이 실행 환경마다 비결정적)과 같은 클래스가 전수 grep으로 2곳 더 나왔다.
이 파일은 그 2곳(`ga4_client._make_date_range`, `deployment_lifecycle.
_utc_midnight_today`)의 UTC 결정화가 실제로 지켜지는지를, monkeypatch로 "로컬 TZ가
이미 다음 날로 넘어갔지만 UTC로는 아직 전날"인 경계를 강제 재현해 고정한다.

두 헬퍼 모두 `datetime`(과, ga4_client의 경우 `date`)을 모듈 top-level에서 import해
쓰므로, `monkeypatch.setattr(모듈, "datetime"/"date", Fake클래스)`로 그 이름이
가리키는 클래스 자체를 갈아 끼우면 함수 안에서의 모든 호출이 고정값을 본다(freezegun
없이 표준 라이브러리만으로 결정적 시각 고정 — 이 레포에 이미 있는 unittest.mock류
관례와 동형)."""
from __future__ import annotations

from datetime import date, datetime, timezone


def test_make_date_range_uses_utc_not_process_local_date(monkeypatch):
    """date.today()가 이미 "내일"(로컬 TZ가 UTC보다 앞선 경우)로 갈린 순간을 강제 —
    UTC 기준 계산이면 "어제"(1일 전)가 UTC 오늘(1/1)의 전날인 12/31, `date.today()`
    (뮤테이션 시 1/2)를 다시 쓰면 1/1이 되어 이 assert가 깨진다."""
    import app.services.ga4_client as mod

    class FakeDate(date):
        @classmethod
        def today(cls):
            return date(2026, 1, 2)  # 로컬(프로세스) "오늘"이 이미 다음 날로 갈린 상황.

    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)  # UTC로는 아직 전날 밤.

    monkeypatch.setattr(mod, "date", FakeDate, raising=False)
    monkeypatch.setattr(mod, "datetime", FakeDatetime)

    start, end = mod._make_date_range(1)

    assert end == "2025-12-31"
    assert start == "2025-12-31"


def test_utc_midnight_today_uses_utc_not_process_local_date(monkeypatch):
    """같은 경계를 `deployment_lifecycle._utc_midnight_today()`에도 강제 — UTC
    기준이면 2026-01-01 00:00:00+00:00, `date.today()`(1/2)를 다시 쓰면 2026-01-02
    00:00:00+00:00가 되어 이 assert가 깨진다."""
    import app.services.deployment_lifecycle as mod

    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 1, 1, 23, 30, tzinfo=timezone.utc)

    monkeypatch.setattr(mod, "datetime", FakeDatetime)

    result = mod._utc_midnight_today()

    assert result == datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
