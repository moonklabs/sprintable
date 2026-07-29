"""story #2262(C-4, E-CONNECT) — 참조 카드의 「지금 상태·다음 행동」 재료. SSOT.

doc `e-connect-c4-trigger-condition-table`(디디 작성, 오르테가군 리뷰 4회 반영, 2026-07-29)의
발생조건표를 그대로 코드화한다 — **조건식만 이 함수들에 있고, 사람-읽는 문구는 여기 없다**
(문구는 유나 lane, 이 모듈은 `next_action_code: str | None`만 반환한다). 카드가 코드를 문구로
번역하는 건 FE/유나 몫 — 이 모듈은 "지어낼 여지가 없는" 조건식만 고정한다.

⛔positive 단방향 규율(has_evidence·self_reported와 동형): "디딜 것이 있다"만 non-None으로
반환한다. "디딜 것 없음"과 "아직 모름"은 여기서 안 가른다 — 발생조건표 감사 결과(2026-07-29)
이 8종 전부 필드가 존재하는 한 "아직 모름"이 구조적으로 안 생긴다(null도 항상 "명시적으로
없음"). 그러므로 이 모듈이 하는 일은 딱 하나 — **인간이 디딜 것이 있으면 코드를, 없으면
None을** 반환하는 것. FE는 None을 "디딜 것 없음"으로 읽으면 된다(이 모듈이 "아직 모름"
케이스를 만들지 않으므로 None과 "모름"을 헷갈릴 자리가 없다).

⛔④주체(사람/시스템) 축: 시스템이 자동으로 처리할 예정인 조건은 **여기서 이미 걸러진다** —
`system_owned_sources`에 속하는 `metric_definition.source`는 조건이 참이어도 None을
반환한다(오르테가 판정 2026-07-29: "시스템이 디딜 것은 카드에 행동으로 안 단다").

⛔스코프(이 첫 PR에서 구현 안 함, 정밀화 필요해 후속으로 미룸 — 지어내지 않는다):
  - epic의 「미결 스토리 수」·「risky_status」 축 — outcome-measurement 축과 동시에 참일 수
    있어 우선순위 판단이 필요하다(어느 것을 "그" next_action으로 보일지). PO 승인 없이
    임의로 순서를 정하지 않는다.
  - sprint의 「기간 지났는데 안 닫힘」 축 — 같은 이유.
  이 두 축은 doc(`e-connect-c4-trigger-condition-table`)에 "미구현·후속 필요"로 기록돼 있다.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# story #2262 AC9④: outcome_status 3단계(n_a→pending→hit|miss, outcome_scorer.py:15 확인)
# 공유 — story/epic/sprint 전부 이 전이를 쓴다.
_OUTCOME_MEASUREMENT_DUE = "outcome_measurement_due"
_VERIFICATION_PENDING = "verification_pending"
_DOC_DECISION_PENDING = "decision_pending"
_DOC_SUPERSEDED = "superseded"
_HYPOTHESIS_MEASUREMENT_DUE = "hypothesis_measurement_due"
_ARTIFACT_UNRESOLVED_COMMENTS = "artifact_has_unresolved_comments"


def _is_system_owned(metric_definition: dict[str, Any] | None, system_owned_sources: frozenset[str]) -> bool:
    if not metric_definition:
        return False
    return metric_definition.get("source") in system_owned_sources


def outcome_measurement_next_action(
    *,
    outcome_status: str,
    measure_after: datetime | None,
    metric_definition: dict[str, Any] | None,
    system_owned_sources: frozenset[str],
    now: datetime | None = None,
) -> str | None:
    """story·epic·sprint 공유 — outcome_status='pending' ∧ measure_after<=now일 때만 사람
    몫("outcome_measurement_due")을 반환한다. `system_owned_sources`에 속하는 source는
    조건이 참이어도 None(④주체=시스템, 카드에 행동으로 안 닮).

    ⛔`n_a`(측정 대상 아님)·`hit`/`miss`(이미 채점됨)·`pending`인데 아직 안 지남은 전부
    None — 발생조건표 §②(확定 없음)에 해당, "디딜 것 없음"이지 "모름"이 아니다."""
    if outcome_status != "pending":
        return None
    if measure_after is None or measure_after > (now or datetime.now(timezone.utc)):
        return None
    if _is_system_owned(metric_definition, system_owned_sources):
        return None
    return _OUTCOME_MEASUREMENT_DUE


def verification_next_action(*, self_reported: bool | None, human_verified: bool | None) -> str | None:
    """story·task 공유 — claimed(self_reported=true) ∧ 아직 human_verified 안 됨일 때만.
    ⛔self_reported가 None/False(주장 자체 없음)·human_verified가 이미 정해짐(True/False
    어느 쪽이든)은 None — "디딜 것 없음"(발생조건표 §②)."""
    if self_reported is not True:
        return None
    if human_verified is not None:
        return None
    return _VERIFICATION_PENDING


def doc_next_action(*, status: str, superseded_by: object | None) -> str | None:
    """superseded_by가 우선(더 확定적인 다음 행동 — "가라"는 목적지가 이미 있다)."""
    if superseded_by is not None:
        return _DOC_SUPERSEDED
    if status == "draft":
        return _DOC_DECISION_PENDING
    return None


def hypothesis_next_action(
    *,
    status: str,
    measure_after: datetime | None,
    metric_definition: dict[str, Any] | None,
    now: datetime | None = None,
) -> str | None:
    """`measuring` ∧ measure_after<=now ∧ source가 자동채점 대상(ga4/internal_ops) 아닐 때만.
    ⛔ga4/internal_ops면 cron(`score_hypotheses`)이 매 실행마다 시도한다(④주체=시스템) —
    실패해도 measuring에 남는 것은 "카드가 채워야 할 다음 행동"이 아니라 별도 결함 신호
    (doc에 "기록, 미판단"으로 남겨둠 — #2262 스코프 밖)."""
    if status != "measuring":
        return None
    if measure_after is None or measure_after > (now or datetime.now(timezone.utc)):
        return None
    if _is_system_owned(metric_definition, frozenset({"ga4", "internal_ops"})):
        return None
    return _HYPOTHESIS_MEASUREMENT_DUE


def artifact_next_action(*, unresolved_comment_count: int) -> str | None:
    if unresolved_comment_count > 0:
        return _ARTIFACT_UNRESOLVED_COMMENTS
    return None
