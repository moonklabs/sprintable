"""org_invites / invitations 이메일 발송 서비스."""
from __future__ import annotations

import logging
import os

from app.services.email import render_email_shell, send_email
from app.services.email_copy import INVITE_COPY

logger = logging.getLogger(__name__)

# story #3206 — 트랜잭셔널 3종·리마인드와 동형 버튼(bg+테두리 병용, Gmail 다크 bg 소실
# 대응). 기존 #6366f1(인디고) 단색 버튼은 v2 브랜드색(#3157FF)+셸 공통 톤으로 정합.
_BUTTON_STYLE = (
    "display:inline-block;padding:12px 24px;background:#3157FF;border:2px solid #3157FF;"
    "color:#ffffff;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;"
)


def _en_role_with_article(role: str) -> str:
    """유나 검수 수정의견②(2026-08-29) — role은 소문자 raw 값(member/admin/owner)이라
    영어에서 관사 없이는 어색("as admin"). 첫 글자 발음 기준 a/an만 판단(그 외 문법
    보정은 발명하지 않는다 — 이 3개 role 외 값이 생기면 별도 검토)."""
    if not role:
        return role
    article = "an" if role[:1].lower() in "aeiou" else "a"
    return f"{article} {role}"


def _build_invite_html(*, org_name: str, inviter_name: str, accept_link: str, role: str, locale: str) -> str:
    """story #3206 — 공용 셸(render_email_shell)이 헤더/푸터를 전담. 이 함수는 콘텐츠
    영역(제목·본문·버튼·폴백 링크·자동생성 안내)만 만든다 — 예전엔 이 함수가 DOCTYPE/
    body/헤더바(#6366f1)/카드/tint 푸터까지 전부 자체 소유했는데(v1 스타일), 유나 v2
    시안이 그 인디고 헤더 바 자체를 실기기 반증으로 폐기했고(색 fill 위계 → 구분선
    위계) 푸터도 회사정보 SSOT가 중복되던 걸 셸 쪽으로 수렴시켰다."""
    copy = INVITE_COPY[locale]
    role_display = _en_role_with_article(role) if locale == "en" else role
    body = copy["body"].format(inviter_name=inviter_name, org_name=org_name, role=role, role_display=role_display)
    content = (
        f"<h2 style='margin:0 0 16px;font-size:20px;color:#1a1a1a'>{copy['heading']}</h2>"
        f"<p style='margin:0 0 12px'>{body}</p>"
        f"<p style='margin:0 0 20px;font-size:13px;color:#595959'>{copy['sub_body']}</p>"
        f"<p style='margin:20px 0'><a href='{accept_link}' style='{_BUTTON_STYLE}'>{copy['cta_label']}</a></p>"
        f"<p style='margin:0 0 8px;font-size:12px;color:#8b8b8b'>"
        f"{copy['fallback_label']}<br>"
        f"<a href='{accept_link}' style='color:#3157FF;text-decoration:underline;word-break:break-all'>{accept_link}</a></p>"
        f"<p style='margin:0;font-size:12px;color:#8b8b8b'>{copy['auto_generated_note']}</p>"
    )
    return render_email_shell(content, locale=locale)


def send_invite_email(
    *,
    to: str,
    org_name: str,
    token: str,
    role: str,
    inviter_name: str = "",
    locale: str = "ko",
) -> str | None:
    """초대 이메일 발송. 성공 시 None, 실패 시 오류 메시지 반환.

    story #3205 — locale은 호출자(org_invites.py)가 「초대 이메일이 이미 이 플랫폼의
    기존 유저 것이면 그 유저의 locale, 아니면(아직 계정 없는 신규 피초대자) DEFAULT_LOCALE」
    로 판별해 넘긴다 — 여기서는 그 값을 그대로 소비만 한다(추측 0, 기존 무회귀 동작이
    바로 그 else 분기).
    """
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    accept_link = f"{app_url}/invite/accept?token={token}"
    copy = INVITE_COPY[locale]
    display_inviter = inviter_name or copy["default_inviter"]

    html_body = _build_invite_html(
        org_name=org_name,
        inviter_name=display_inviter,
        accept_link=accept_link,
        role=role,
        locale=locale,
    )

    try:
        delivered = send_email(
            to=to,
            subject=copy["subject"].format(org_name=org_name),
            html_body=html_body,
        )
        if not delivered:
            # E-ONBOARDING S4: provider 미설정 → 콘솔 fallback은 실발송 아님.
            # error로 surface해 email_sent_at=null + 경고가 UI에 노출되도록(무음 거짓 성공 차단).
            logger.warning("Invite email NOT delivered (provider unconfigured) to %s", to)
            return "email provider not configured — invite email was not delivered"
        return None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send invite email to %s", to)
        return str(exc)
