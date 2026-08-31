"""story #3261 no-fiction 가드(2026-08-31 실사고 재발 방지). 실 dev 사고에서 나온 문장을
그대로 회귀 테스트에 박아둔다."""
from __future__ import annotations

from app.no_fiction_guard import looks_like_fabricated_handoff_claim

# 실사고 원문(pgstat-probe-dev 조회로 확인) — support_execution_logs에 escalation 행 0인
# 상태로 이 텍스트가 나왔다.
_REAL_INCIDENT_TEXT = (
    "죄송합니다. 내부 시스템에 오류가 발생하여 담당자 연결도 실패했습니다. 매우 불편하시겠지만, "
    "잠시 후 다시 시도해주시거나 저희 웹사이트의 '문의하기'를 통해 연락해주시면 감사하겠습니다. "
    "다시 한번 불편을 드려 대단히 죄송합니다."
)


def test_catches_real_incident_text():
    assert looks_like_fabricated_handoff_claim(_REAL_INCIDENT_TEXT) is True


def test_catches_success_claim_too():
    assert looks_like_fabricated_handoff_claim("담당자에게 바로 연결해 드렸습니다.") is True


def test_does_not_flag_normal_inquiry_answer():
    assert looks_like_fabricated_handoff_claim("새 스프린트는 백로그에서 '스프린트 만들기'로 시작하세요.") is False


def test_does_not_flag_future_tense_offer_to_escalate():
    """"연결해 드릴게요"(미래·의도 표명)는 결과 서술이 아니다 — escalate 도구를 실제로 부르는
    행위와 별개로, 아직 안 일어난 일을 "하겠다"고 말하는 건 지어낸 게 아니다."""
    assert looks_like_fabricated_handoff_claim("네, 담당자에게 연결해 드릴게요. 잠시만 기다려 주세요.") is False


def test_does_not_flag_unrelated_failure_mention():
    assert looks_like_fabricated_handoff_claim("결제가 실패했다면 카드 정보를 다시 확인해 주세요.") is False
