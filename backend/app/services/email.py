"""이메일 발송 서비스 — Resend API 우선, SMTP fallback, 콘솔 최종 fallback."""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, html_body: str) -> bool:
    """이메일 발송.

    우선순위: RESEND_API_KEY → EMAIL_SMTP_HOST → 콘솔 출력 fallback.
    반환: **True = Resend/SMTP로 실제 발송됨. False = provider 미설정 → 콘솔 fallback(실발송 아님)**.
    provider 발송 실패 시 예외를 re-raise — 호출자가 오류 처리 책임.
    (E-ONBOARDING S4: False/예외를 호출자가 '미발송'으로 surface해 무음 성공을 차단.)
    """
    resend_key = os.getenv("RESEND_API_KEY", "")
    if resend_key:
        _send_via_resend(to=to, subject=subject, html_body=html_body, api_key=resend_key)
        return True

    smtp_host = os.getenv("EMAIL_SMTP_HOST", "")
    if smtp_host:
        _send_via_smtp(to=to, subject=subject, html_body=html_body, smtp_host=smtp_host)
        return True

    # provider 미설정 — 콘솔 fallback은 실제 발송이 아니다. 호출자가 '미발송'으로 처리해야 함.
    logger.warning("[EMAIL FALLBACK] provider 미설정 — 실발송 아님. To: %s | Subject: %s", to, subject)
    return False


def _send_via_resend(*, to: str, subject: str, html_body: str, api_key: str) -> None:
    import resend  # type: ignore[import]
    resend.api_key = api_key
    from_addr = os.getenv("EMAIL_FROM", "Sprintable <noreply@sprintable.ai>")
    resend.Emails.send({
        "from": from_addr,
        "to": [to],
        "subject": subject,
        "html": html_body,
    })


def _send_via_smtp(*, to: str, subject: str, html_body: str, smtp_host: str) -> None:
    from_addr = os.getenv("EMAIL_FROM", "noreply@sprintable.ai")
    smtp_port = int(os.getenv("EMAIL_SMTP_PORT", "587"))
    smtp_user = os.getenv("EMAIL_SMTP_USER", "")
    smtp_pass = os.getenv("EMAIL_SMTP_PASSWORD", "")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as s:
        s.starttls()
        if smtp_user:
            s.login(smtp_user, smtp_pass)
        s.send_message(msg)
