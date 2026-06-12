"""L2-S4: Phase 1 휴리스틱 evaluator 단위 테스트.

AC① pure/read-only·LLM/외부호출 0(import 가드)·AC② threshold env·AC③ decision 필드·
AC④ Sprint.end_date/Epic.target_date/measure_after만(story due_date 없음).
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timedelta, timezone

from app.services import l2_heuristics as mod
from app.services.l2_heuristics import (
    DeadlineTarget,
    DroughtTarget,
    HeuristicEvaluator,
    HeuristicThresholds,
    TriggerDecision,
    VelocityTarget,
)

NOW = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
AGENT = uuid.uuid4()


def _eval(**over):
    return HeuristicEvaluator(HeuristicThresholds(**over)) if over else HeuristicEvaluator(HeuristicThresholds())


# ── ① 데드라인 ─────────────────────────────────────────────────────────────────

def test_deadline_sprint_within_24h_fires():
    t = DeadlineTarget("sprint", uuid.uuid4(), NOW + timedelta(hours=10), "active", AGENT)
    out = _eval().evaluate_deadline(t, NOW, source_activity_seq=42)
    assert len(out) == 1
    d = out[0]
    assert d.trigger_type == "deadline_approaching"
    assert d.target_agent_id == AGENT and d.anchor_type == "sprint" and d.anchor_id == t.entity_id
    assert d.source_activity_seq == 42 and "남음" in d.reason


def test_deadline_sprint_outside_window_skips():
    t = DeadlineTarget("sprint", uuid.uuid4(), NOW + timedelta(hours=48), "active", AGENT)
    assert _eval().evaluate_deadline(t, NOW) == []


def test_deadline_epic_uses_3d_window():
    # 50h 남음: sprint(24h) 윈도우면 skip이지만 epic(72h) 윈도우면 발사.
    t = DeadlineTarget("epic", uuid.uuid4(), NOW + timedelta(hours=50), "active", AGENT)
    assert len(_eval().evaluate_deadline(t, NOW)) == 1


def test_deadline_hypothesis_measure_after_24h():
    t = DeadlineTarget("hypothesis", uuid.uuid4(), NOW + timedelta(hours=5), "testing", AGENT)
    out = _eval().evaluate_deadline(t, NOW)
    assert len(out) == 1 and out[0].anchor_type == "hypothesis"


def test_deadline_overdue_fires_with_overdue_reason():
    t = DeadlineTarget("sprint", uuid.uuid4(), NOW - timedelta(hours=6), "active", AGENT)
    out = _eval().evaluate_deadline(t, NOW)
    assert len(out) == 1 and "초과" in out[0].reason


def test_deadline_terminal_status_skips():
    for s in ("done", "closed", "n/a", "n_a", "cancelled"):
        t = DeadlineTarget("sprint", uuid.uuid4(), NOW + timedelta(hours=1), s, AGENT)
        assert _eval().evaluate_deadline(t, NOW) == [], s


def test_deadline_none_deadline_or_agent_skips():
    assert _eval().evaluate_deadline(DeadlineTarget("sprint", uuid.uuid4(), None, "active", AGENT), NOW) == []
    assert _eval().evaluate_deadline(
        DeadlineTarget("sprint", uuid.uuid4(), NOW + timedelta(hours=1), "active", None), NOW
    ) == []


def test_deadline_unknown_entity_type_skips():
    # story-level due_date는 없음(AC④) — story는 데드라인 소스가 아님.
    t = DeadlineTarget("story", uuid.uuid4(), NOW + timedelta(hours=1), "in-progress", AGENT)
    assert _eval().evaluate_deadline(t, NOW) == []


# ── ② 이벤트 가뭄 ──────────────────────────────────────────────────────────────

def test_drought_in_progress_24h_fires():
    t = DroughtTarget("story", uuid.uuid4(), "in-progress", NOW - timedelta(hours=25), AGENT)
    out = _eval().evaluate_drought(t, NOW)
    assert len(out) == 1 and out[0].trigger_type == "event_drought" and out[0].anchor_type == "story"


def test_drought_in_review_uses_12h():
    # 18h 무활동: in-progress(24h)면 skip이나 in-review(12h)면 발사.
    assert len(_eval().evaluate_drought(DroughtTarget("story", uuid.uuid4(), "in-review", NOW - timedelta(hours=18), AGENT), NOW)) == 1
    assert _eval().evaluate_drought(DroughtTarget("story", uuid.uuid4(), "in-progress", NOW - timedelta(hours=18), AGENT), NOW) == []


def test_drought_sprint_36h():
    assert len(_eval().evaluate_drought(DroughtTarget("sprint", uuid.uuid4(), "active", NOW - timedelta(hours=40), AGENT), NOW)) == 1
    assert _eval().evaluate_drought(DroughtTarget("sprint", uuid.uuid4(), "active", NOW - timedelta(hours=30), AGENT), NOW) == []


def test_drought_below_threshold_skips():
    assert _eval().evaluate_drought(DroughtTarget("story", uuid.uuid4(), "in-progress", NOW - timedelta(hours=2), AGENT), NOW) == []


def test_drought_none_last_activity_or_non_active_story_skips():
    assert _eval().evaluate_drought(DroughtTarget("story", uuid.uuid4(), "in-progress", None, AGENT), NOW) == []
    # todo/done story는 가뭄 대상 아님.
    assert _eval().evaluate_drought(DroughtTarget("story", uuid.uuid4(), "todo", NOW - timedelta(hours=99), AGENT), NOW) == []


# ── ③ 속도 급변 ────────────────────────────────────────────────────────────────

def test_velocity_lag_fires():
    # 경과 60%, committed 100 → 기대 60SP, done 20 < 30(=60*0.5) → lag.
    t = VelocityTarget(uuid.uuid4(), AGENT, elapsed_ratio=0.6, done_points=20, committed_points=100, capacity_points=100)
    out = _eval().evaluate_velocity(t, NOW)
    types = {d.trigger_type for d in out}
    assert "velocity_lag" in types


def test_velocity_spike_fires():
    # 경과 20%, committed 100 → 기대 20SP, done 60 > 50(=20*2.5) → spike.
    t = VelocityTarget(uuid.uuid4(), AGENT, elapsed_ratio=0.2, done_points=60, committed_points=100, capacity_points=200)
    assert "velocity_spike" in {d.trigger_type for d in _eval().evaluate_velocity(t, NOW)}


def test_velocity_scope_creep_fires():
    # committed 130 > capacity 100*1.2=120 → scope_creep.
    t = VelocityTarget(uuid.uuid4(), AGENT, elapsed_ratio=0.5, done_points=50, committed_points=130, capacity_points=100)
    assert "scope_creep" in {d.trigger_type for d in _eval().evaluate_velocity(t, NOW)}


def test_velocity_healthy_sprint_no_decisions():
    # 경과 50%, 기대 50SP, done 50(정시)·committed≤capacity → 무발사.
    t = VelocityTarget(uuid.uuid4(), AGENT, elapsed_ratio=0.5, done_points=50, committed_points=100, capacity_points=100)
    assert _eval().evaluate_velocity(t, NOW) == []


def test_velocity_multiple_fire_together():
    # lag(경과 50%·done 10<25) + scope_creep(committed 200>capacity 100*1.2).
    t = VelocityTarget(uuid.uuid4(), AGENT, elapsed_ratio=0.5, done_points=10, committed_points=200, capacity_points=100)
    types = {d.trigger_type for d in _eval().evaluate_velocity(t, NOW)}
    assert {"velocity_lag", "scope_creep"} <= types


def test_velocity_no_target_agent_skips():
    t = VelocityTarget(uuid.uuid4(), None, elapsed_ratio=0.9, done_points=0, committed_points=100, capacity_points=10)
    assert _eval().evaluate_velocity(t, NOW) == []


# ── AC②: threshold env config ──────────────────────────────────────────────────

def test_thresholds_from_env_override_and_bad_value_fallback():
    env = {
        "L2_DEADLINE_SPRINT_END_H": "6",
        "L2_VELOCITY_SPIKE_FACTOR": "3.0",
        "L2_DROUGHT_SPRINT_H": "not-a-number",  # 폴백.
    }
    t = HeuristicThresholds.from_env(env)
    assert t.deadline_sprint_end_h == 6.0
    assert t.velocity_spike_factor == 3.0
    assert t.drought_sprint_h == HeuristicThresholds().drought_sprint_h  # 폴백 기본값.


def test_env_threshold_changes_decision():
    # 기본 24h면 skip인 10h 잔여가, env로 6h→12h 늘리면 발사.
    t = DeadlineTarget("sprint", uuid.uuid4(), NOW + timedelta(hours=10), "active", AGENT)
    assert HeuristicEvaluator(HeuristicThresholds(deadline_sprint_end_h=6.0)).evaluate_deadline(t, NOW) == []
    assert len(HeuristicEvaluator(HeuristicThresholds(deadline_sprint_end_h=12.0)).evaluate_deadline(t, NOW)) == 1


# ── AC①: pure / read-only · LLM·네트워크 import 0 (import 가드) ─────────────────

def test_module_has_no_llm_or_network_imports():
    src = inspect.getsource(mod)
    forbidden = ("openai", "anthropic", "httpx", "requests", "aiohttp", "urllib", "boto3", "litellm")
    for name in forbidden:
        assert f"import {name}" not in src and f"from {name}" not in src, name


def test_evaluator_methods_take_no_db_session():
    # read-only 보증: 평가 메서드 시그니처에 db/session/AsyncSession 파라미터가 없어야 한다.
    for m in ("evaluate_deadline", "evaluate_drought", "evaluate_velocity"):
        params = set(inspect.signature(getattr(HeuristicEvaluator, m)).parameters)
        assert not (params & {"db", "session", "conn"}), m


def test_decision_is_frozen_and_has_ac3_fields():
    d = TriggerDecision("t", AGENT, "sprint", uuid.uuid4(), "r", 1)
    for f in ("trigger_type", "target_agent_id", "anchor_type", "anchor_id", "reason", "source_activity_seq"):
        assert hasattr(d, f)
    import pytest

    with pytest.raises(Exception):
        d.reason = "x"  # type: ignore[misc]
