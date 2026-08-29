"""이메일 발송 서비스 — Resend API 우선, SMTP fallback, 콘솔 최종 fallback."""
import html
import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger(__name__)

# story #3206(유나 v2 시안, doc email-brand-shell-proposal-3206, 아티팩트 afaeca1f) —
# apps/web/src/lib/legal/business-info.ts(전자상거래법 §10 SSOT)와 자구 그대로 일치시킨
# 백엔드측 사본. 그 파일이 앱 내 유일 정본이라 import는 못 하지만(별도 런타임), 값은
# 글자 단위로 동일해야 한다 — 그쪽이 바뀌면 이쪽도 같이 바뀌어야 함(자동 동기화 없음).
_COMPANY_NAME = "주식회사 뭉클랩"
_COMPANY_CEO = "윤도선"
_COMPANY_REG_NO = "488-88-02579"
_COMPANY_ADDRESS = "경기도 고양시 일산동구 무궁화로 20-38, 5층 502호"
_COMPANY_PHONE = "070-8098-5775"


def render_email_shell(content_html: str, *, locale: str = "ko") -> str:
    """story #3206 — 발송 메일 공용 브랜드 셸(유나 v2 시안, 아티팩트 afaeca1f).

    v1(색 헤더 바·tint 푸터)이 실기기 반증(선생님 갤럭시 Gmail 다크 = bgcolor 강제
    재배색으로 색 헤더 바·버튼 bg·카드 bg가 통째 소실)으로 폐기되고, v2는 위계를
    **구분선·여백·타이포 굵기**로만 세운다(색 fill에 의존한 위계는 반전되면 사라짐).
    로고도 이미지 미표시가 실기기 확認이라 텍스트 워드마크만 쓴다.

    호출자는 내부 콘텐츠 HTML만 만들어 넘기면 된다 — 문서 골격(DOCTYPE/table 셸/
    헤더/푸터)은 전부 이 함수 책임(단일 조립 지점, 사이트 전체 발송 메일 공통).

    ⚠️ 푸터에 "도움말" 링크는 넣지 않는다 — 시안엔 있으나 실제 목적지 페이지가
    앱에 없다(grounding 확認: `/help` 라우트 부재). 임의 URL을 짓지 않고 이용약관·
    개인정보처리방침(실존 라우트, business-info.ts LEGAL_DOC_ROUTES)만 남긴다 —
    페이지가 생기면 그때 추가."""
    year = datetime.now(timezone.utc).year
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    terms_url = f"{app_url}/terms"
    privacy_url = f"{app_url}/privacy"
    return f"""<!DOCTYPE html>
<html lang="{locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body style="margin:0;padding:0;background:#e9e7e1;font-family:-apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e7e1;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #ececec;">
        <tr><td style="padding:22px 32px 16px;border-bottom:1px solid #ececec;">
          <span style="font-size:20px;font-weight:800;letter-spacing:-.3px;color:#3157FF;">Sprintable</span>
        </td></tr>
        <tr><td style="padding:22px 32px;font-size:14px;line-height:1.6;color:#1a1a1a;">
          {content_html}
        </td></tr>
        <tr><td style="border-top:1px solid #ececec;padding:16px 32px;font-size:11px;line-height:1.7;color:#9a9a9a;">
          <span style="font-weight:700;color:#6b6b6b;">Sprintable</span> · Ship with AI agents<br>
          {_COMPANY_NAME} · 대표이사 {_COMPANY_CEO} · 사업자등록번호 {_COMPANY_REG_NO}<br>
          {_COMPANY_ADDRESS} · {_COMPANY_PHONE}<br>
          <a href="{terms_url}" style="color:#8b8b8b;text-decoration:underline;">이용약관</a> · <a href="{privacy_url}" style="color:#8b8b8b;text-decoration:underline;">개인정보처리방침</a><br>
          © {year} Sprintable
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def render_action_email(
    *,
    intro_lines: list[str],
    cta_label: str,
    cta_url: str,
    expiry_note: str,
    security_note: str,
    fallback_label: str,
    locale: str = "ko",
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

    story #3206(유나 v2 시안, 실기기 반증 반영) — 버튼은 bg+테두리 병용(#3157FF, Gmail
    다크가 bg를 죽여도 테두리 상자+굵은 글자로 여전히 버튼으로 읽힘)·전체를
    render_email_shell()로 감싸 헤더(워드마크+구분선)·푸터(구분선+회사정보)를 얹는다.
    """
    intro_html = "".join(f"<p style='margin:0 0 10px'>{html.escape(line)}</p>" for line in intro_lines)
    content = (
        f"{intro_html}"
        f"<p style='margin:20px 0'>"
        f"<a href='{cta_url}' "
        f"style='display:inline-block;padding:12px 24px;background:#3157FF;border:2px solid #3157FF;"
        f"color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px'>"
        f"{html.escape(cta_label)}</a></p>"
        f"<p style='font-size:13px;color:#595959;margin:0 0 8px'>{html.escape(expiry_note)}</p>"
        f"<p style='font-size:12px;color:#8b8b8b;margin:0 0 8px'>"
        f"{html.escape(fallback_label)}<br>"
        f"<a href='{cta_url}' style='color:#3157FF;text-decoration:underline'>{cta_url}</a></p>"
        f"<p style='font-size:12px;color:#8b8b8b;margin:0'>{html.escape(security_note)}</p>"
    )
    return render_email_shell(content, locale=locale)


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
