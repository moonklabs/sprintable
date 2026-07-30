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


def test_category_unknown_code_falls_back_to_none_with_warning(caplog):
    """⛔민군 지적(2026-07-30, PO 판정 — "가드는 CI에·폴백은 운영에"): 운영 경로(응답
    직렬화 시점 computed_field)에서 매핑 밖 코드를 만나도 절대 안 던진다 — list
    엔드포인트에서 레코드 한 건의 미분류가 응답 전체를 500으로 끌고 가면 안 되기
    때문(사용자를 인질로 개발자에게 말하는 가드는 가드가 아니다). None을 반환하고
    logger.warning만 남긴다 — 새 코드 분류 누락을 «잡는» 자리는 아래 CI 회귀테스트."""
    import logging
    with caplog.at_level(logging.WARNING, logger="app.services.next_action"):
        result = next_action_category("some_future_code_nobody_classified")
    assert result is None
    assert "미분류" in caplog.text


def test_all_returned_codes_are_classified():
    """⛔민군 지적(2026-07-30): 기존 버전은 NEXT_ACTION_CATEGORIES를 자기 자신과 대조하는
    동어반복이라 "등록된 것이 등록돼 있다"만 확認하고 영원히 통과했다 — 새 코드를
    실제로 추가하고 분류를 빠뜨려도 절대 안 잡혔을 것이다. 대신 4개 함수를 각자의
    "발생조건"(위 test_*_returns_code들과 동일 트리거 입력)으로 «실제 호출»해 진짜
    반환값 집합을 뽑고, 그걸 NEXT_ACTION_CATEGORIES와 대조한다 — 독립 원본이라 새
    코드가 추가되고 분류가 빠지면 이 대조가 실제로 깨진다."""
    actually_returned_codes = {
        outcome_measurement_next_action(
            outcome_status="pending", measure_after=_PAST, metric_definition={"source": "manual"},
            system_owned_sources=frozenset({"ga4"}), now=_NOW,
        ),
        verification_next_action(self_reported=True, human_verified=None),
        doc_next_action(status="draft"),
        hypothesis_next_action(
            status="measuring", measure_after=_PAST, metric_definition={"source": "manual"}, now=_NOW,
        ),
    }
    assert None not in actually_returned_codes, "발생조건 트리거 입력이 잘못돼 코드가 안 나온다"
    assert actually_returned_codes == set(NEXT_ACTION_CATEGORIES)
