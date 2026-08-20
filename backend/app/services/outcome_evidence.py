"""근거(evidence) 서버측 강제 판정 — story #2038(hypothesis verified/falsified) 원안을
story #2843(goal hit/miss·unmeasurable)이 공유하도록 추출. 두 엔티티가 각자 사본을 들면
그 사본이 갈리는 자리가 다음 사고(#2832류)의 씨앗이라 단일 정의로 공유한다."""
from __future__ import annotations

import math


def has_valid_outcome_evidence(outcome_result: dict | None) -> bool:
    """실측 판정(hit/miss·verified/falsified)의 근거 요건 — 실제 수치(actual)와 한 줄 근거
    (reason) 둘 다 필요. FE(HypothesisResolveDialog)의 canSubmit과 동형(story #2038)."""
    if not isinstance(outcome_result, dict):
        return False
    actual = outcome_result.get("actual")
    # bool은 Python에서 int 서브클래스라 명시적으로 배제(isinstance(True, int) is True 함정).
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        return False
    if isinstance(actual, float) and math.isnan(actual):
        return False
    reason = outcome_result.get("reason")
    return isinstance(reason, str) and bool(reason.strip())


def has_valid_unmeasurable_reason(outcome_result: dict | None) -> bool:
    """story #2843 — «측정 불가» 명시 선언의 근거 요건. 실측치가 없다는 게 이 판정의 본질이라
    actual은 요구하지 않는다(요구하면 unmeasurable 자체가 성립 불가) — 사유(reason)만 필수."""
    if not isinstance(outcome_result, dict):
        return False
    reason = outcome_result.get("reason")
    return isinstance(reason, str) and bool(reason.strip())
