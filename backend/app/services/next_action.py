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

⛔⭐PO 판정(2026-07-29, PR#2633 머지 後 리뷰): 원래 이 모듈이 낸 6개 코드 중 `superseded`
(doc)·`artifact_has_unresolved_comments`(artifact)는 뺐다 — 「이름은 다음 행동인데 값
셋 중 하나는 과거 사실이었다」는 지적(§3-1 "상태를 바꾸는 것 vs 보는 것"과 같은 축의
문제) + 그 둘이 각각 `DocResponse.superseded_by`·`VisualArtifactSummary.
unresolved_comment_count`라는 **이미 있는 원자 필드**와 완전히 같은 사실을 중복으로
실었던 것(한 사실이 두 칸에 살면 언젠가 갈라진다). FE 소비가 0%였으므로 빼도 없어지는
동작은 0 — "아무도 안 읽으므로 뺀다"가 근거이지 "응답에 이미 있다"가 근거가 아니다
(응답에 있는 것과 화면에 보이는 것은 다른 사실 — 그 차이를 여기 명시해 둔다).

⭐그 결과 남은 4개 코드는 딱 두 축으로 갈린다("내가 지금 손을 대면 무언가 달라지는가"가
판별자): actionable(㉠, 손대면 달라짐) vs waiting(㉡, 남이 해야 해서 안 달라짐).
`NEXT_ACTION_CATEGORIES`가 그 매핑의 SSOT다 — FE가 코드별로 각자 판단하면 7번째 코드가
생길 때 또 어긋난다(오늘 겪은 "코드 목록을 FE가 하드코딩" 함정과 같은 병). 새 코드를
추가하려면 반드시 이 매핑에도 넣어야 한다 — ⛔단 그 가드는 「CI에」 산다(회귀테스트가
next_action.py 소스에서 실제 반환값을 독립 추출해 대조), 「운영에」는 안 산다(민군 지적
2026-07-30 — `next_action_category`는 매핑 밖 코드를 만나도 절대 안 던지고 None+경고
로그만 남긴다, 아래 함수 docstring 참조).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# story #2262 AC9④: outcome_status 3단계(n_a→pending→hit|miss, outcome_scorer.py:15 확인)
# 공유 — story/epic/sprint 전부 이 전이를 쓴다.
_OUTCOME_MEASUREMENT_DUE = "outcome_measurement_due"
_VERIFICATION_PENDING = "verification_pending"
_DOC_DECISION_PENDING = "decision_pending"
_HYPOTHESIS_MEASUREMENT_DUE = "hypothesis_measurement_due"

ACTIONABLE = "actionable"  # ㉠내 행동 — 손대면 달라진다
WAITING = "waiting"  # ㉡남 대기 — 남이 해야 해서 안 달라진다

# ⛔이 매핑 밖의 코드가 next_action_code로 나가면 안 된다 — 아래 함수들이 반환하는 모든
# non-None 값은 반드시 여기 있어야 한다(회귀테스트가 이 불변식을 지킨다).
NEXT_ACTION_CATEGORIES: dict[str, str] = {
    _OUTCOME_MEASUREMENT_DUE: ACTIONABLE,
    _HYPOTHESIS_MEASUREMENT_DUE: ACTIONABLE,
    _VERIFICATION_PENDING: WAITING,
    _DOC_DECISION_PENDING: WAITING,
}


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


def doc_next_action(*, status: str) -> str | None:
    """⛔story #2262(C-4, PO 판정 2026-07-29): `superseded_by` 분기를 뺐다 —
    `DocResponse.superseded_by`(uuid|None)가 이미 원자 필드로 응답에 있어 완전히 같은
    사실을 두 칸에 중복으로 실었던 것("대체됨"은 애초에 다음 행동이 아니라 "이 문서를
    믿지 마라"는 경고라, 다음 행동 칸에 있을 물건이 아니었다). FE는 superseded_by가
    아닌지를 그 원자 필드로 직접 판정한다."""
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


def next_action_category(code: str | None) -> str | None:
    """`next_action_code`를 ㉠actionable/㉡waiting으로 분류(SSOT — FE가 각자 안 판단한다).
    None(디딜 것 없음)은 그대로 None.

    ⛔민군 지적(2026-07-30, PO 판정 — "가드는 CI에·폴백은 운영에"): 이 함수는
    `@computed_field`(schemas/*.py)로 응답 직렬화 시점에 도는지라, 여기서 던지면
    list 엔드포인트에서 레코드 «한 건»의 미분류가 응답 «전체»를 opaque 500으로
    끌고 간다(사용자를 인질로 개발자에게 말하는 것 — 가드가 아니다). 그래서 운영
    경로는 절대 던지지 않는다 — 매핑 밖 코드는 `None`을 반환하고 `logger.warning`
    으로만 남긴다. `None`은 `next_action_code` 자체가 이미 `str | None`이라 FE에
    새 분기가 필요 없는 «이미 정당한 값»이다. 「새 코드 추가 시 분류를 빠뜨리는
    실수」를 잡는 자리는 CI의 회귀테스트(아래 `test_all_returned_codes_are_
    classified`, next_action.py 소스에서 실제 반환값을 독립 추출해 대조)다 —
    운영 코드 경로가 그 가드 역할을 겸하지 않는다."""
    if code is None:
        return None
    category = NEXT_ACTION_CATEGORIES.get(code)
    if category is None:
        logger.warning(
            "next_action_category: 미분류 코드 %r — NEXT_ACTION_CATEGORIES에 추가 필요"
            "(CI 회귀테스트가 이걸 빨개지게 해야 하는데 여기까지 왔다는 것 자체가 이상 신호)",
            code,
        )
    return category
