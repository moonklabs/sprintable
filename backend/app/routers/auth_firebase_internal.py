"""story 132e7204(E-AUTH-REBUILD M2 Phase1-S4·doc §4.4): 서비스-투-서비스 전용 Firebase 세션쿠키
발급 내부 엔드포인트. Next.js BFF(`POST /api/auth/firebase/session`)가 이걸 호출해 완성된
세션쿠키 값을 받아 그대로 `__Host-sp_fs`에 Set-Cookie 한다(BFF는 Firebase Admin 왕복 불필요).

cron.py와 동일한 공유시크릿 패턴(`Authorization: Bearer <secret>`) — 공개 API 아님.

⛔이 엔드포인트는 세션쿠키 값을 JSON으로 반환한다 — doc §4.4 7단계 "쿠키를 JSON으로 반환
금지"는 **브라우저에 노출되는 응답**(BFF→브라우저)에 대한 제약이고, 이건 신뢰된 내부
서비스간 호출(FastAPI→Next.js BFF)이라 다른 계층. BFF가 이 값을 받아 Set-Cookie 헤더로만
내보내고 자신의 JSON 응답 바디엔 절대 포함하지 않을 책임은 FE lane(S4 Next.js 실구현) 몫.

**Phase 1-3 스코프 경계**: 이미 `auth_identities`에 매핑된 identity만 세션 발급 허용 —
unmapped 사용자에 대한 신규 provisioning은 Phase 3(cohort 승인) 이후 스코프(doc §5 Phase 3).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.auth_identity import AuthIdentity
from app.models.user import User
from app.services.firebase_session_mint import mint_session_cookie
from app.services.firebase_verifier import verify_firebase_id_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/auth", tags=["auth", "firebase", "internal"])

_AUTH_TIME_MAX_AGE_SECONDS = 5 * 60  # doc §4.4 3단계: now - auth_time <= 5분


class FirebaseSessionMintRequest(BaseModel):
    id_token: str


class FirebaseSessionMintResponse(BaseModel):
    session_cookie: str
    expires_in: int


def _require_internal_secret(authorization: str | None) -> None:
    secret = settings.firebase_bff_internal_secret
    if not secret:
        # cron.py와 동일 정책: 로컬 개발에서 시크릿 미설정 시 허용(운영은 반드시 설정).
        return
    if authorization != f"Bearer {secret}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal credential")


@router.post("/firebase-session", response_model=FirebaseSessionMintResponse)
async def mint_firebase_session(
    body: FirebaseSessionMintRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> FirebaseSessionMintResponse:
    _require_internal_secret(authorization)

    if not settings.firebase_auth_issue_session:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Firebase session issuance not enabled")

    verified = await verify_firebase_id_token(body.id_token, settings.firebase_project_id)
    if verified is None:
        logger.warning("auth.firebase.session_mint rejected reason=id_token_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Firebase ID token")

    now = datetime.now(timezone.utc).timestamp()
    if now - verified.auth_time > _AUTH_TIME_MAX_AGE_SECONDS:
        logger.warning("auth.firebase.session_mint rejected reason=auth_time_stale")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication too old")

    identity_row = (
        await db.execute(
            select(AuthIdentity).where(
                AuthIdentity.issuer == verified.issuer,
                AuthIdentity.subject == verified.firebase_uid,
                AuthIdentity.unlinked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if identity_row is None:
        logger.warning("auth.firebase.session_mint rejected reason=unmapped_identity")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unmapped Firebase identity")

    user = await db.get(User, identity_row.user_id)
    if user is None or not user.is_active:
        logger.warning("auth.firebase.session_mint rejected reason=inactive_or_missing_user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    valid_duration_seconds = 5 * 24 * 60 * 60
    session_cookie = await mint_session_cookie(
        body.id_token, settings.firebase_project_id, valid_duration_seconds
    )
    if session_cookie is None:
        logger.warning("auth.firebase.session_mint failed reason=mint_failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Session cookie mint failed")

    logger.info("auth.firebase.session_mint success")
    return FirebaseSessionMintResponse(session_cookie=session_cookie, expires_in=valid_duration_seconds)
