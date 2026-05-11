"""AUTH-02: Email validation + 대소문자 정규화 테스트."""
import pytest
from pydantic import ValidationError

from app.routers.auth import LoginRequest, RegisterRequest
from app.schemas.invitation import CreateInvitation
import uuid


# ─── RegisterRequest ──────────────────────────────────────────────────────────

def test_register_valid_email():
    r = RegisterRequest(email="User@Example.COM", password="TestPass1!")
    assert r.email == "user@example.com"


def test_register_invalid_email_no_at():
    with pytest.raises(ValidationError) as exc:
        RegisterRequest(email="notanemail", password="TestPass1!")
    assert "email" in str(exc.value).lower() or "Invalid" in str(exc.value)


def test_register_invalid_email_no_domain():
    with pytest.raises(ValidationError):
        RegisterRequest(email="user@", password="TestPass1!")


def test_register_email_strips_whitespace():
    r = RegisterRequest(email="  user@example.com  ", password="TestPass1!")
    assert r.email == "user@example.com"


# ─── LoginRequest ─────────────────────────────────────────────────────────────

def test_login_email_lowercased():
    r = LoginRequest(email="ADMIN@EXAMPLE.COM", password="anypassword")
    assert r.email == "admin@example.com"


def test_login_invalid_email():
    with pytest.raises(ValidationError):
        LoginRequest(email="bad-email", password="pass")


# ─── CreateInvitation ─────────────────────────────────────────────────────────

def test_invitation_email_normalized():
    inv = CreateInvitation(
        email="Invited@Company.ORG",
        invited_by=uuid.uuid4(),
    )
    assert inv.email == "invited@company.org"


def test_invitation_invalid_email():
    with pytest.raises(ValidationError):
        CreateInvitation(email="not-an-email", invited_by=uuid.uuid4())


# ─── 중복 차단 (대소문자) ────────────────────────────────────────────────────────

def test_same_email_different_case_normalizes_to_same():
    """대소문자 다른 동일 이메일이 동일 값으로 정규화되는 것 확인."""
    r1 = RegisterRequest(email="Test@Email.com", password="TestPass1!")
    r2 = RegisterRequest(email="test@email.com", password="TestPass1!")
    assert r1.email == r2.email
