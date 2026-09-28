"""story #4191(PR #4550 CI) — 봉인 필드 예시값. 시각 예시는 고정 날짜가 아니라 렌더 시점 기준
«조직 시간대로 내일 09:00» — 예시를 그대로 베껴도 과거 시각 발송 요청이 되지 않는다."""
from __future__ import annotations

from datetime import datetime, timezone

from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS, _sealed_field_ok, sealed_field_example


def _specs():
    return {spec.name: spec for spec in _GATE_TYPE_SEALED_FIELDS["newsletter_send"]}


def test_scheduled_at_example_is_always_in_the_future_and_valid():
    spec = _specs()["scheduled_at"]
    now = datetime.now(timezone.utc)
    example = sealed_field_example(spec, org_timezone=None)
    assert datetime.fromisoformat(example) > now
    assert _sealed_field_ok(spec, example)


def test_scheduled_at_example_uses_org_timezone_tomorrow_0900():
    spec = _specs()["scheduled_at"]
    # UTC 3/1 14:30 = 서울 3/1 23:30 → 서울 «내일» 3/2 09:00(+09:00), UTC «내일» 3/2 09:00(+00:00).
    now = datetime(2027, 3, 1, 14, 30, tzinfo=timezone.utc)
    assert sealed_field_example(spec, org_timezone="Asia/Seoul", now=now) == "2027-03-02T09:00:00+09:00"
    assert sealed_field_example(spec, org_timezone=None, now=now) == "2027-03-02T09:00:00+00:00"


def test_every_newsletter_example_passes_its_own_validation():
    for spec in _GATE_TYPE_SEALED_FIELDS["newsletter_send"]:
        assert _sealed_field_ok(spec, sealed_field_example(spec, org_timezone="Asia/Seoul")), spec.name
