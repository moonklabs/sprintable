"""AUTH-01: RegisterRequest 비밀번호 검증 규칙 테스트."""
import pytest
from pydantic import ValidationError

from app.routers.auth import RegisterRequest


def _make(password: str) -> RegisterRequest:
    return RegisterRequest(email="test@example.com", password=password)


def test_valid_password_upper_lower_digit():
    """대문자+소문자+숫자 3조합 — 통과."""
    r = _make("Abcdef12")
    assert r.password == "Abcdef12"


def test_valid_password_upper_lower_special():
    """대문자+소문자+특수문자 3조합 — 통과."""
    r = _make("Abcdef!@")
    assert r.password == "Abcdef!@"


def test_valid_password_all_four():
    """4가지 전부 — 통과."""
    r = _make("Abcde1!!")
    assert r.password == "Abcde1!!"


def test_too_short_rejects():
    """7자 이하 — 422."""
    with pytest.raises(ValidationError) as exc_info:
        _make("Ab1!xyz")
    assert "8 characters" in str(exc_info.value)


def test_only_two_categories_rejects():
    """소문자+숫자 2조합만 — 422."""
    with pytest.raises(ValidationError) as exc_info:
        _make("abcde123")
    assert "3 of" in str(exc_info.value)


def test_only_lowercase_rejects():
    """소문자만 — 422."""
    with pytest.raises(ValidationError):
        _make("abcdefgh")


def test_only_uppercase_rejects():
    """대문자만 — 422."""
    with pytest.raises(ValidationError):
        _make("ABCDEFGH")


def test_single_char_rejects():
    """단일 문자 — 422."""
    with pytest.raises(ValidationError):
        _make("a")


def test_login_not_affected():
    """LoginRequest는 validator 없음 — 약한 비밀번호도 객체 생성 가능."""
    from app.routers.auth import LoginRequest
    req = LoginRequest(email="u@example.com", password="weak")
    assert req.password == "weak"
