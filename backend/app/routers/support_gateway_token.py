"""story #3259(지원v1·1경계) — Support Gateway 위임 토큰 발급. backend 쪽에서 이 스토리가
건드리는 **유일한** 지점 — 나머지는 전부 support-gateway/ 독립 디렉터리.

이 엔드포인트가 주는 건 {org_id, user_id, exp} 3개 클레임뿐이다. fleet 자격(API key·MCP
시크릿·billing 상태 등) 어느 것도 이 토큰에 실리지 않는다 — Support Gateway가 그런 자격을
받아 들고 있게 되는 순간 "fleet 자격 0" 불변식이 깨지므로, 클레임 셋을 여기서 의도적으로
좁게 고정한다(확장하고 싶어지면 그 자체가 §2 경계 위반 신호).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from jose import jwt as jose_jwt
from pydantic import BaseModel

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user

router = APIRouter(prefix="/api/v2/support", tags=["support-gateway"])


class SupportSessionTokenResponse(BaseModel):
    token: str
    expires_in: int


@router.post("/session-token", response_model=SupportSessionTokenResponse)
async def issue_support_session_token(
    auth: AuthContext = Depends(get_current_user),
) -> SupportSessionTokenResponse:
    if not settings.support_gateway_token_secret:
        # fail-closed — 위임 토큰 시크릿 미설정 상태로 발급하면 Support Gateway 쪽 검증이
        # 항상 실패할 뿐 아니라, 설정 누락을 조용히 감추게 된다.
        raise HTTPException(status_code=503, detail="support gateway not configured")
    if not auth.org_id:
        raise HTTPException(status_code=400, detail="org context required")

    now = datetime.now(timezone.utc)
    ttl = settings.support_gateway_token_ttl_seconds
    claims = {
        "org_id": auth.org_id,
        "user_id": auth.user_id,
        "exp": now + timedelta(seconds=ttl),
        "iat": now,
    }
    token = jose_jwt.encode(claims, settings.support_gateway_token_secret, algorithm="HS256")
    return SupportSessionTokenResponse(token=token, expires_in=ttl)
