"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5·doc §9.1·산티아고 §9 코드 보안계약 2026-07-15):
`POST /api/v2/native-bootstrap` — 네이티브 모바일 앱이 WebView 밖에서 직접 호출(공개 API,
쿠키 인증 아님). Firebase ID token을 exact Bearer로만 받는다(산티아고: "/native-bootstrap=
cookie auth 아니라 exact Firebase Bearer+App Check+CORS 닫기" — CORS 정책 자체는 인프라
전역 설정으로 이 PR 스코프 밖).

⚠️App Check 검증은 "요청이 진짜 앱에서 왔다"만 증명한다 — 산티아고가 요구한 완전한
"설치별(per-installation) key/challenge" device binding은 모바일 클라이언트가 별도
challenge-response 메커니즘을 구현해야 하는 별개 스코프(아직 없음, 향후 모바일 스토리
필요). 이 스토리에선 App Check 앱 무결성 증명 + 클라이언트 제공 install hint를 조합해
`device_binding_hash`를 구성 — 완전한 암호학적 per-device 증명은 아니다(정직하게 표기).
"""
from __future__ import annotations

import hashlib
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
from app.services.firebase_verifier import verify_app_check_token, verify_firebase_id_token
from app.services.native_bootstrap import DEFAULT_TTL_SECONDS, issue_bootstrap_code

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/auth", tags=["auth", "firebase", "mobile"])

_AUTH_TIME_MAX_AGE_SECONDS = 5 * 60


class NativeBootstrapRequest(BaseModel):
    app_check_token: str | None = None
    device_install_hint: str | None = None


class NativeBootstrapResponse(BaseModel):
    code: str
    expires_in: int


def _extract_bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer "):]


@router.post("/native-bootstrap", response_model=NativeBootstrapResponse)
async def native_bootstrap(
    body: NativeBootstrapRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> NativeBootstrapResponse:
    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Native bootstrap not enabled")

    id_token = _extract_bearer(authorization)
    if id_token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Firebase ID token")

    verified = await verify_firebase_id_token(id_token, settings.firebase_project_id)
    if verified is None:
        logger.warning("auth.native_bootstrap rejected reason=id_token_invalid")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Firebase ID token")

    now = datetime.now(timezone.utc).timestamp()
    if now - verified.auth_time > _AUTH_TIME_MAX_AGE_SECONDS:
        logger.warning("auth.native_bootstrap rejected reason=auth_time_stale")
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
        logger.warning("auth.native_bootstrap rejected reason=unmapped_identity")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unmapped Firebase identity")

    user = await db.get(User, identity_row.user_id)
    if user is None or not user.is_active:
        logger.warning("auth.native_bootstrap rejected reason=inactive_or_missing_user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    device_binding_hash: str | None = None
    if settings.firebase_auth_mobile_app_check_required and not body.app_check_token:
        logger.warning("auth.native_bootstrap rejected reason=app_check_required_missing")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="App Check token required")

    if body.app_check_token:
        app_check = await verify_app_check_token(body.app_check_token, settings.firebase_project_number)
        if app_check is None:
            logger.warning("auth.native_bootstrap rejected reason=app_check_invalid")
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid App Check token")
        device_binding_hash = hashlib.sha256(
            f"{app_check.app_id}:{body.device_install_hint or ''}".encode()
        ).hexdigest()

    code = await issue_bootstrap_code(
        db,
        user_id=identity_row.user_id,
        firebase_uid=verified.firebase_uid,
        project_id=settings.firebase_project_id,
        device_binding_hash=device_binding_hash,
        ttl_seconds=DEFAULT_TTL_SECONDS,
    )
    logger.info("auth.native_bootstrap success")
    return NativeBootstrapResponse(code=code, expires_in=DEFAULT_TTL_SECONDS)
