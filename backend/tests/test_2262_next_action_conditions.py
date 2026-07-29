"""story #2262(C-4) AC9 — app.services.next_action의 조건식 단위 검증. 순수 함수(DB 무접촉)라
실PG 없이 돈다. doc `e-connect-c4-trigger-condition-table`의 발생조건표를 그대로 pin한다 —
①있음/②확定 없음/④주체 세 축을 각 함수마다 양성·음성 대조로 고정.

⛔PO 판정(2026-07-29, PR#2633 머지 後 리뷰): `artifact_next_action`(unresolved_comment_count
재노출뿐)·doc_next_action의 `superseded_by` 분기(superseded_by 원자 필드와 중복)를 뺐다 —
next_action.py 모듈 docstring 참조. 아래 테스트도 그에 맞춰 갱신."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.next_action import (
    NEXT_ACTION_CATEGORIES,
    doc_next_action,
    hypothesis_next_action,
    next_action_category,
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
    assert doc_next_action(status="draft") == "decision_pending"


def test_doc_decided_returns_none():
    assert doc_next_action(status="active") is None


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


# ─── next_action_category (PO 판정 2026-07-29, §3-1과 같은 축) ───────────────


def test_category_none_code_returns_none():
    assert next_action_category(None) is None


def test_category_actionable_codes():
    assert next_action_category("outcome_measurement_due") == "actionable"
    assert next_action_category("hypothesis_measurement_due") == "actionable"


def test_category_waiting_codes():
    assert next_action_category("verification_pending") == "waiting"
    assert next_action_category("decision_pending") == "waiting"


def test_category_unknown_code_raises():
    """새 코드를 next_action.py에 추가하면서 NEXT_ACTION_CATEGORIES에 안 넣는 실수를
    조용히 통과시키지 않는다 — KeyError로 즉시 드러난다."""
    import pytest
    with pytest.raises(KeyError):
        next_action_category("some_future_code_nobody_classified")


def test_all_returned_codes_are_classified():
    """이 모듈이 실제로 반환하는 모든 코드가 NEXT_ACTION_CATEGORIES에 있다 — 회귀 시
    새 코드를 추가하고 분류를 빠뜨리면 여기서 잡힌다."""
    assert set(NEXT_ACTION_CATEGORIES) == {
        "outcome_measurement_due", "hypothesis_measurement_due",
        "verification_pending", "decision_pending",
    }
