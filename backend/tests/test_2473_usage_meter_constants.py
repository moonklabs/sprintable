"""story #2473(결제②-A3) — usage_meter.py의 Python 상수(ALLOWED_METER_TYPES/AU_WEIGHTS)가
migration 0287의 DB CHECK와 어긋나지 않는지 pin. 실PG 불요(순수 상수 검증) — 실제 DB
CHECK 자체는 test_2473_usage_meters_v2_3_meter_types_realdb.py가 커버한다."""
from __future__ import annotations

from app.models.usage_meter import ALLOWED_METER_TYPES, AU_WEIGHTS


def test_allowed_meter_types_has_old_and_new_axes():
    old = {"ai_calls", "storage_mb", "members", "agents", "stt_minutes"}
    new = {"automation_units", "realtime_connections", "webhooks", "automation_rules", "event_replay_days"}
    assert old <= ALLOWED_METER_TYPES
    assert new <= ALLOWED_METER_TYPES
    assert ALLOWED_METER_TYPES == old | new


def test_au_weights_seam_matches_policy_v2_1_section_4_5():
    assert AU_WEIGHTS == {"read": 1, "write": 5, "batch_per_entity": 5}
