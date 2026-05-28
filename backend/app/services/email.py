"""이메일 발송 서비스 — Resend API 우선, SMTP fallback, 콘솔 최종 fallback."""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, html_body: str) -> None:
    """이메일 발송.

    우선순위: RESEND_API_KEY → EMAIL_SMTP_HOST → 콘솔 출력 fallback.
    실패 시 예외를 re-raise — 호출자가 오류 처리 책임.
    """
    resend_key = os.getenv("RESEND_API_KEY", "")
    if resend_key:
        _send_via_resend(to=to, subject=subject, html_body=html_body, api_key=resend_key)
        return

    smtp_host = os.getenv("EMAIL_SMTP_HOST", "")
    if smtp_host:
        _send_via_smtp(to=to, subject=subject, html_body=html_body, smtp_host=smtp_host)
        return

    logger.info("[EMAIL FALLBACK] To: %s | Subject: %s\n%s", to, subject, html_body)


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
