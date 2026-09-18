"""story #3387 — has_discontinue_signal 단위 검증. story 5b00f0bc(넛지 억제, 아직 코드
없음)이 나중에 이 함수를 그대로 재사용하므로 여기서 계약을 고정해 둔다."""
from __future__ import annotations

import pytest

from app.services.gate_reason_signal import has_discontinue_signal


@pytest.mark.parametrize("text", [
    "발행 금지·폐기 대상",
    "폐기 대상입니다",
    "당분간 중단합니다",
    "이 계정은 사용 금지",
    "산출물 삭제 요청",
])
def test_discontinue_keywords_detected(text: str) -> None:
    assert has_discontinue_signal(text) is True


@pytest.mark.parametrize("text", [
    "제목 오타 수정 필요",
    "본문 형식이 가이드와 다릅니다",
    "요약이 너무 깁니다, 3줄로 줄여주세요",
])
def test_normal_reasons_not_flagged(text: str) -> None:
    assert has_discontinue_signal(text) is False


@pytest.mark.parametrize("text", [None, ""])
def test_missing_reason_is_no_signal(text) -> None:
    assert has_discontinue_signal(text) is False
