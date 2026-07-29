"""story #2262(C-4) AC9 — app.services.next_action의 조건식 단위 검증. 순수 함수(DB 무접촉)라
실PG 없이 돈다. doc `e-connect-c4-trigger-condition-table`의 발생조건표를 그대로 pin한다 —
①있음/②확定 없음/④주체 세 축을 각 함수마다 양성·음성 대조로 고정."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.next_action import (
    artifact_next_action,
    doc_next_action,
    hypothesis_next_action,
    outcome_measurement_next_action,
    verification_next_action,
)

_NOW = datetime(2026, 7, 29, 12, 0, 0, tzinfo=timezone.utc)
_PAST = _NOW - timedelta(days=1)
_FUTURE = _NOW + timedelta(days=1)


# ─── outcome_measurement_next_action (story·epic·sprint 공유) ───────────────


def test_outcome_due_human_source_returns_code():
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=_PAST, metric_definition={"source": "manual"},
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) == "outcome_measurement_due"


def test_outcome_due_no_metric_definition_still_human():
    """source가 아예 없으면(metric_definition=None) 시스템 소유가 아니므로 사람 몫."""
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=_PAST, metric_definition=None,
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) == "outcome_measurement_due"


def test_outcome_due_but_system_owned_returns_none():
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=_PAST, metric_definition={"source": "ga4"},
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) is None


def test_outcome_due_internal_ops_system_owned_for_epic_sprint():
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=_PAST, metric_definition={"source": "internal_ops"},
        system_owned_sources=frozenset({"ga4", "internal_ops"}), now=_NOW,
    ) is None


def test_outcome_not_yet_due_returns_none():
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=_FUTURE, metric_definition=None,
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) is None


def test_outcome_n_a_returns_none():
    assert outcome_measurement_next_action(
        outcome_status="n_a", measure_after=None, metric_definition=None,
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) is None


def test_outcome_already_scored_hit_miss_returns_none():
    for status in ("hit", "miss"):
        assert outcome_measurement_next_action(
            outcome_status=status, measure_after=_PAST, metric_definition=None,
            system_owned_sources=frozenset({"ga4"}), now=_NOW,
        ) is None


def test_outcome_pending_measure_after_none_returns_none():
    """pending인데 measure_after가 없으면(데이터 불일치) 판정 못 하므로 None — 지어내지 않는다."""
    assert outcome_measurement_next_action(
        outcome_status="pending", measure_after=None, metric_definition=None,
        system_owned_sources=frozenset({"ga4"}), now=_NOW,
    ) is None


# ─── verification_next_action (story·task 공유) ─────────────────────────────


def test_verification_claimed_not_verified_returns_code():
    assert verification_next_action(self_reported=True, human_verified=None) == "verification_pending"


def test_verification_no_claim_returns_none():
    assert verification_next_action(self_reported=None, human_verified=None) is None
    assert verification_next_action(self_reported=False, human_verified=None) is None


def test_verification_already_resolved_returns_none_either_direction():
    assert verification_next_action(self_reported=True, human_verified=True) is None
    assert verification_next_action(self_reported=True, human_verified=False) is None


# ─── doc_next_action ─────────────────────────────────────────────────────────


def test_doc_draft_returns_decision_pending():
    assert doc_next_action(status="draft", superseded_by=None) == "decision_pending"


def test_doc_superseded_returns_superseded_even_if_also_draft():
    """superseded_by가 우선 — 더 확定적인 다음 행동(가야 할 곳이 이미 정해짐)."""
    import uuid
    target = uuid.uuid4()
    assert doc_next_action(status="draft", superseded_by=target) == "superseded"
    assert doc_next_action(status="active", superseded_by=target) == "superseded"


def test_doc_decided_not_superseded_returns_none():
    assert doc_next_action(status="active", superseded_by=None) is None


# ─── hypothesis_next_action ───────────────────────────────────────────────────


def test_hypothesis_measuring_due_human_source_returns_code():
    assert hypothesis_next_action(
        status="measuring", measure_after=_PAST, metric_definition={"source": "manual"}, now=_NOW,
    ) == "hypothesis_measurement_due"


def test_hypothesis_measuring_due_auto_source_returns_none():
    for source in ("ga4", "internal_ops"):
        assert hypothesis_next_action(
            status="measuring", measure_after=_PAST, metric_definition={"source": source}, now=_NOW,
        ) is None


def test_hypothesis_not_measuring_status_returns_none():
    for status in ("proposed", "active", "verified", "falsified", "killed", "archived"):
        assert hypothesis_next_action(
            status=status, measure_after=_PAST, metric_definition={"source": "manual"}, now=_NOW,
        ) is None


def test_hypothesis_measuring_not_yet_due_returns_none():
    assert hypothesis_next_action(
        status="measuring", measure_after=_FUTURE, metric_definition={"source": "manual"}, now=_NOW,
    ) is None


# ─── artifact_next_action ─────────────────────────────────────────────────────


def test_artifact_unresolved_returns_code():
    assert artifact_next_action(unresolved_comment_count=3) == "artifact_has_unresolved_comments"


def test_artifact_zero_returns_none():
    assert artifact_next_action(unresolved_comment_count=0) is None
