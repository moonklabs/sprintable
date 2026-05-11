"""이메일 발송 서비스 — SMTP 또는 콘솔 fallback."""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, html_body: str) -> None:
    """이메일 발송. EMAIL_SMTP_HOST 미설정 시 콘솔 출력으로 fallback."""
    smtp_host = os.getenv("EMAIL_SMTP_HOST", "")
    if not smtp_host:
        logger.info("[EMAIL FALLBACK] To: %s | Subject: %s\n%s", to, subject, html_body)
        return

    from_addr = os.getenv("EMAIL_FROM", "noreply@sprintable.ai")
    smtp_port = int(os.getenv("EMAIL_SMTP_PORT", "587"))
    smtp_user = os.getenv("EMAIL_SMTP_USER", "")
    smtp_pass = os.getenv("EMAIL_SMTP_PASSWORD", "")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as s:
            s.starttls()
            if smtp_user:
                s.login(smtp_user, smtp_pass)
            s.send_message(msg)
    except Exception:
        logger.exception("Failed to send email to %s", to)
