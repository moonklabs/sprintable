"""E-ONBOARDING S4: 초대 실메일 발송 — 무음 실패 가시화.

핵심: provider 미설정(콘솔 fallback)이나 Resend 실패를 '발송완료'로 무음 처리하지 않고,
send_invite_email이 error를 반환 → 라우터가 email_sent_at=null + email_error로 surface.
"""
from __future__ import annotations

from unittest.mock import patch

from app.services.email import send_email
from app.services.org_invite_email import send_invite_email


# ── send_email: 실발송 여부를 bool로 반환 ─────────────────────────────────────

def test_send_email_false_on_console_fallback():
    """provider env 없음 → 콘솔 fallback → False(실발송 아님)."""
    with patch.dict("os.environ", {}, clear=True):
        assert send_email(to="a@b.com", subject="s", html_body="<p>x</p>") is False


def test_send_email_true_on_resend():
    """RESEND_API_KEY 있으면 Resend 발송 → True."""
    with patch.dict("os.environ", {"RESEND_API_KEY": "re_test"}, clear=True), \
         patch("app.services.email._send_via_resend") as mock_resend:
        assert send_email(to="a@b.com", subject="s", html_body="<p>x</p>") is True
        mock_resend.assert_called_once()


# ── send_invite_email: 무음 성공 차단 ─────────────────────────────────────────

def test_invite_email_warns_on_unconfigured_provider():
    """콘솔 fallback(False) → error 문자열 반환(무음 '성공' 아님)."""
    with patch("app.services.org_invite_email.send_email", return_value=False):
        err = send_invite_email(to="x@y.com", org_name="Org", token="t", role="member")
    assert err is not None and "not" in err.lower()  # surface된 경고


def test_invite_email_none_on_real_delivery():
    """실발송(True) → None(성공)."""
    with patch("app.services.org_invite_email.send_email", return_value=True):
        assert send_invite_email(to="x@y.com", org_name="Org", token="t", role="member") is None


def test_invite_email_returns_error_on_exception():
    """Resend 예외 → error 문자열(라우터가 email_sent_at=null로 처리)."""
    with patch("app.services.org_invite_email.send_email", side_effect=RuntimeError("resend 500")):
        err = send_invite_email(to="x@y.com", org_name="Org", token="t", role="member")
    assert err is not None and "resend 500" in err
