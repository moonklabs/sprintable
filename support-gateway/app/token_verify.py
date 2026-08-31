"""위임 토큰 검증 — 이 서비스가 가진 유일한 "신뢰 재료"(config.py 참고). backend의 어떤 fleet
자격(JWT_SECRET·API Key·MCP 시크릿)도 이 모듈이 알 필요가 없다: 서명이 SUPPORT_GATEWAY_TOKEN_SECRET
로 유효하면 클레임을 그대로 믿는다 — org 소속 여부를 다시 DB로 확인하지 않는다(그럴 DB 자체가
없다, AC2). 발급 측 계약은 backend/app/routers/support_gateway_token.py 참고."""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

from app.config import settings


class DelegatedTokenError(Exception):
    pass


@dataclass(frozen=True)
class DelegatedIdentity:
    org_id: uuid.UUID
    user_id: uuid.UUID


def verify_delegated_token(token: str) -> DelegatedIdentity:
    if not settings.token_secret:
        # fail-closed — 시크릿 미설정은 "무제한 허용"이 아니라 "전부 거부"(memory
        # feedback_actor_type_failclosed와 동형: 신뢰 재료 부재=최대 보수 판정).
        raise DelegatedTokenError("SUPPORT_GATEWAY_TOKEN_SECRET not configured")
    try:
        claims = jwt.decode(token, settings.token_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise DelegatedTokenError(str(exc)) from exc
    try:
        org_id = uuid.UUID(claims["org_id"])
        user_id = uuid.UUID(claims["user_id"])
    except (KeyError, ValueError) as exc:
        raise DelegatedTokenError(f"malformed claims: {exc}") from exc
    return DelegatedIdentity(org_id=org_id, user_id=user_id)


async def require_delegated_identity(authorization: str = Header(default="")) -> DelegatedIdentity:
    """FastAPI dependency — Authorization: Bearer <delegated token>. 자격 없으면 401(라우트 자체가
    존재를 노출하는 404가 아니라 401 — 인가 없음과 자원 부재를 섞지 않는다)."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return verify_delegated_token(token)
    except DelegatedTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid delegated token: {exc}") from exc
