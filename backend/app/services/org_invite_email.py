"""org_invites 이메일 발송 서비스."""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def send_invite_email(*, to: str, org_name: str, token: str, role: str) -> str | None:
    """초대 이메일 발송. 성공 시 None, 실패 시 오류 메시지 반환."""
    app_url = os.getenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    accept_link = f"{app_url}/invite/accept?token={token}"

    html_body = (
        f"<p><strong>{org_name}</strong> 조직에 <strong>{role}</strong>로 초대됐는.</p>"
        f"<p>아래 링크를 클릭하여 초대를 수락하면 됩니다. 7일 이내 유효한 링크입니다.</p>"
        f"<p><a href='{accept_link}'>초대 수락하기</a></p>"
        f"<p>링크가 보이지 않으면 아래 주소를 브라우저에 붙여넣어 사용하세요:<br>{accept_link}</p>"
    )

    try:
        from app.services.email import send_email
        send_email(
            to=to,
            subject=f"[Sprintable] {org_name} 조직 초대",
            html_body=html_body,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to send invite email to %s", to)
        return str(exc)
