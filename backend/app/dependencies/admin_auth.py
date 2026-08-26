"""story #2777(E-ADMIN-REDESIGN·결제 운영) — 어드민 처리 액션(빌링 재시도·사용권 부여)
SA ID-token 인가 게이트.

backend-dev/prod는 IAP 뒤가 아니라 공개 run.app 직결 서빙이다(PO 실측 2026-08-18 — MCP/
에이전트가 지금도 직결 호출 중). 그래서 sprintable-admin internal-api의 dual-lane(human
IAP + agent SA)이 아니라, **agent lane 하나만**(SA ID token + email allowlist) 이식한다
— admin-web이 자기 서버 사이드에서 operator SA로 이 backend를 audience로 하는 ID token을
발급받아 Bearer로 붙여 호출하는 것을 전제.

미설정(audience 또는 allowlist 없음) = 503(fail-closed) — internal-api core/auth.py의
`auth_configured` 원칙과 동일."""
from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Header, HTTPException, status
from google.auth.transport import requests as ga_requests
from google.oauth2 import id_token

from app.core.config import settings

logger = logging.getLogger("sprintable.admin_auth")

_FORBIDDEN = HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="forbidden")
_UNCONFIGURED = HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="admin auth not configured")


@dataclass(frozen=True)
class AdminOperator:
    email: str
    subject: str


def _ga_request() -> ga_requests.Request:
    return ga_requests.Request()


async def require_admin_operator(
    authorization: str | None = Header(default=None),
) -> AdminOperator:
    if not settings.admin_operator_auth_configured:
        logger.error("admin operator auth not configured (audience/allowlist empty) — fail-closed")
        raise _UNCONFIGURED

    if not authorization or not authorization.lower().startswith("bearer "):
        raise _FORBIDDEN
    token = authorization.split(" ", 1)[1].strip()
    try:
        claims = id_token.verify_oauth2_token(
            token, _ga_request(), audience=settings.admin_operator_audience
        )
    except Exception as e:  # noqa: BLE001 — 어떤 검증 실패도 403로 닫는다(internal-api와 동형)
        logger.warning("admin operator token verify failed: %s", e)
        raise _FORBIDDEN from e

    email = (claims.get("email") or "").lower()
    subject = claims.get("sub") or ""
    if not claims.get("email_verified", False) or not email or not subject:
        logger.warning("admin operator token missing email_verified/email/sub: %r", email)
        raise _FORBIDDEN
    if email not in settings.admin_operator_allowlist_set:
        logger.warning("admin operator not in allowlist: %r", email)
        raise _FORBIDDEN
    return AdminOperator(email=email, subject=subject)
