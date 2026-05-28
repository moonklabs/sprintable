"""org_invites / invitations 이메일 발송 서비스."""
from __future__ import annotations

import logging
import os

from app.services.email import send_email

logger = logging.getLogger(__name__)

_BUTTON_STYLE = (
    "display:inline-block;padding:12px 28px;background:#6366f1;color:#ffffff;"
    "text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;"
)


def _build_invite_html(*, org_name: str, inviter_name: str, accept_link: str, role: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="ko">
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
          <h2 style="margin:0 0 16px;font-size:22px;color:#111827;">팀에 초대됐어요!</h2>
          <p style="margin:0 0 12px;color:#374151;line-height:1.6;">
            <strong>{inviter_name}</strong>님이 <strong>{org_name}</strong> 조직에
            <strong>{role}</strong>로 초대했습니다.
          </p>
          <p style="margin:0 0 32px;color:#6b7280;font-size:14px;line-height:1.6;">
            아래 버튼을 클릭하면 초대를 수락할 수 있습니다. 링크는 7일간 유효합니다.
          </p>
          <a href="{accept_link}" style="{_BUTTON_STYLE}">초대 수락하기</a>
          <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
            버튼이 보이지 않으면 아래 주소를 브라우저에 붙여 넣으세요:<br>
            <a href="{accept_link}" style="color:#6366f1;word-break:break-all;">{accept_link}</a>
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;">
            © 2025 Sprintable. 이 이메일은 초대 발송으로 자동 생성되었습니다.
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
) -> str | None:
    """초대 이메일 발송. 성공 시 None, 실패 시 오류 메시지 반환."""
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    accept_link = f"{app_url}/invite/accept?token={token}"
    display_inviter = inviter_name or "팀 관리자"

    html_body = _build_invite_html(
        org_name=org_name,
        inviter_name=display_inviter,
        accept_link=accept_link,
        role=role,
    )

    try:
        send_email(
            to=to,
            subject=f"[Sprintable] {org_name} 조직에 초대됐습니다",
            html_body=html_body,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send invite email to %s", to)
        return str(exc)
