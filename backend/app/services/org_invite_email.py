"""org_invites / invitations 이메일 발송 서비스."""
from __future__ import annotations

import logging
import os

from app.services.email import send_email
from app.services.email_copy import INVITE_COPY

logger = logging.getLogger(__name__)

_BUTTON_STYLE = (
    "display:inline-block;padding:12px 28px;background:#6366f1;color:#ffffff;"
    "text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;"
)


def _en_role_with_article(role: str) -> str:
    """유나 검수 수정의견②(2026-08-29) — role은 소문자 raw 값(member/admin/owner)이라
    영어에서 관사 없이는 어색("as admin"). 첫 글자 발음 기준 a/an만 판단(그 외 문법
    보정은 발명하지 않는다 — 이 3개 role 외 값이 생기면 별도 검토)."""
    article = "an" if role[:1].lower() in "aeiou" else "a"
    return f"{article} {role}"


def _build_invite_html(*, org_name: str, inviter_name: str, accept_link: str, role: str, locale: str) -> str:
    from datetime import datetime, timezone

    copy = INVITE_COPY[locale]
    role_display = _en_role_with_article(role) if locale == "en" else role
    body = copy["body"].format(inviter_name=inviter_name, org_name=org_name, role=role, role_display=role_display)
    footer = copy["footer"].format(year=datetime.now(timezone.utc).year)
    return f"""<!DOCTYPE html>
<html lang="{copy['html_lang']}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
        <!-- Header -->
        <tr><td style="background:#6366f1;padding:28px 40px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;">Sprintable</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:40px 40px 32px;">
          <h2 style="margin:0 0 16px;font-size:22px;color:#111827;">{copy['heading']}</h2>
          <p style="margin:0 0 12px;color:#374151;line-height:1.6;">
            {body}
          </p>
          <p style="margin:0 0 32px;color:#6b7280;font-size:14px;line-height:1.6;">
            {copy['sub_body']}
          </p>
          <a href="{accept_link}" style="{_BUTTON_STYLE}">{copy['cta_label']}</a>
          <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
            {copy['fallback_label']}<br>
            <a href="{accept_link}" style="color:#6366f1;word-break:break-all;">{accept_link}</a>
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">
            {footer}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


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
