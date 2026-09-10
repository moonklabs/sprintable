"""story #3758(BE·표시명·결함 클래스 별건④) — auth.py:684 email-로컬파트 폴백 제거.

`RegisterRequest.display_name: str`(Optional 아님)이라 필드 자체 부재는 이미 422로
막히지만, 빈 문자열/공백뿐인 값은 그 갭을 통과해 라우터가 `.strip() or email.split("@")[0]`로
email 절반을 이름 자리에 지어내고 있었다(member_resolver.py 5자리·#3755와 같은 클래스).
이제 Pydantic validator가 원천에서 거부한다 — 순수 스키마 단위 테스트(DB/HTTP 불요)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.routers.auth import RegisterRequest


def _make(display_name: str) -> RegisterRequest:
    return RegisterRequest(
        email="new@example.com",
        password="Pw12345678!",
        display_name=display_name,
        tos_accepted=True,
    )


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_blank_display_name_rejected_422(blank: str):
    """⭐양성대조 — 예전엔 이 값들이 그대로 통과해 email 로컬파트 폴백을 유발했다."""
    with pytest.raises(ValidationError) as exc_info:
        _make(blank)
    assert "display_name" in str(exc_info.value)


def test_real_display_name_passes_through_stripped():
    """음성대조 — 실명은 그대로(앞뒤 공백만 정리) 통과, 폴백 로직 자체가 필요 없다."""
    req = _make("  실명 사용자  ")
    assert req.display_name == "실명 사용자"


def test_missing_display_name_field_still_422():
    """무회귀 — 필드 자체 부재는 이미 예전부터 422(Optional 아님)였다."""
    with pytest.raises(ValidationError):
        RegisterRequest(email="new@example.com", password="Pw12345678!", tos_accepted=True)
