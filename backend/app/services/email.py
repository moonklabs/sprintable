"""이메일 발송 서비스 — Resend API 우선, SMTP fallback, 콘솔 최종 fallback."""
import html
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)


def render_action_email(
    *,
    intro_lines: list[str],
    cta_label: str,
    cta_url: str,
    expiry_note: str,
    security_note: str,
    fallback_label: str,
) -> str:
    """story #3196-⑤(카피·톤 제안 — 유나 홀름, doc auth-email-copy-proposal-3196) — 인사/
    맥락 → CTA 버튼 → 만료 → 폴백 평문 링크 → 보안 안내, 트랜잭셔널 메일 3종(가입 인증·
    인증 재발송·비밀번호 재설정) 공용 골격. 리마인드 메일(_reminder_email_body)과 같은
    합니다체·구조를 쓰되, 그쪽은 마케팅성(수신거부 있음)이라 별도 함수로 남긴다 — 이
    렌더러는 트랜잭셔널 전용(보안 안내가 필수 파라미터인 이유).

    카피·톤·구조는 제안 그대로, 버튼 인라인 CSS는 이 함수(배선측 권한, 제안 doc 명시)
    — 이메일 클라이언트 호환을 위해 flexbox/grid 없이 순수 인라인 스타일만 사용.
    cta_url은 이미 서버가 만든 신뢰 URL(app_url + 서버 발급 토큰)만 들어온다 — 사용자
    입력이 아니므로 URL 자체는 escape하지 않되(속성값 내 홑따옴표가 안 섞이는 내부 생성값),
    사람이 쓰는 텍스트(intro_lines·cta_label·expiry_note·security_note·fallback_label)는
    html.escape로 XSS/마크업 주입을 방지한다.

    story #3205 QA(까디르, 2026-08-29) — fallback_label이 예전엔 렌더러 내부에 ko로
    하드코딩돼 있어 en 메일에도 한국어 한 줄이 섞였다(호출자가 카피를 100% 못 갈아끼우는
    구조적 결함). 다른 4개 필드와 동형으로 파라미터화.
    """
    intro_html = "".join(f"<p>{html.escape(line)}</p>" for line in intro_lines)
    return (
        f"{intro_html}"
        f"<p style='margin:24px 0'>"
        f"<a href='{cta_url}' "
        f"style='display:inline-block;padding:12px 24px;background:#2952E3;color:#ffffff;"
        f"text-decoration:none;border-radius:6px;font-weight:600'>"
        f"{html.escape(cta_label)}</a></p>"
        f"<p>{html.escape(expiry_note)}</p>"
        f"<p style='font-size:12px;color:#595959'>"
        f"{html.escape(fallback_label)}<br>"
        f"<a href='{cta_url}'>{cta_url}</a></p>"
        f"<p style='font-size:12px;color:#595959'>{html.escape(security_note)}</p>"
    )


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
