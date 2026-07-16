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
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import limiter
from app.dependencies.database import get_db
from app.models.auth_identity import AuthIdentity
from app.models.device_installation import DeviceInstallation
from app.models.user import User
from app.services.device_proof import (
    PURPOSE_BOOTSTRAP_ISSUE,
    TTL_BOOTSTRAP_ISSUE_SECONDS,
    ChallengeAlreadyActiveError,
    issue_challenge,
)
from app.services.firebase_verifier import verify_app_check_token, verify_firebase_id_token
from app.services.native_bootstrap import DEFAULT_TTL_SECONDS, issue_bootstrap_code
from app.services.native_request_auth import verify_native_request

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


def _allowed_app_ids() -> frozenset[str]:
    raw = settings.firebase_app_check_allowed_app_ids
    return frozenset(x.strip() for x in raw.split(",") if x.strip())


# 산티아고 §9(2026-07-15) 잔여 하드닝: public issuance는 rate limit 없음 지적 — 로그인류
# 엔드포인트와 동일 임계값(app/routers/auth.py register 패턴 재사용).
@router.post("/native-bootstrap", response_model=NativeBootstrapResponse)
@limiter.limit("10/minute")
async def native_bootstrap(
    request: Request,
    body: NativeBootstrapRequest,
    response: Response,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> NativeBootstrapResponse:
    response.headers["Cache-Control"] = "no-store"  # 산티아고 §9 잔여 하드닝.

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
        app_check = await verify_app_check_token(
            body.app_check_token, settings.firebase_project_number, _allowed_app_ids()
        )
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


# story 822817a0(C1·doc §7.1/§7.5): bootstrap_issue 챌린지 발급 — §7.5 2단계 원자 트랜잭션의
# 1단계 준비물(실제 원자 issue+redeem-challenge 동시생성 배선은 C4). 여기서는 이미 등록된
# active 설치가 자신의 것임을 확인하고 챌린지만 발급한다. App Check는 필수(구 위 엔드포인트의
# optional 스킴과 다름 — §7 신규 프로토콜은 강제).
class NativeBootstrapChallengeRequest(BaseModel):
    app_check_token: str | None = None
    installation_id: str


class NativeBootstrapChallengeResponse(BaseModel):
    challenge_id: str
    client_data_b64url: str
    expires_in: int


@router.post("/native-bootstrap/challenges", response_model=NativeBootstrapChallengeResponse)
@limiter.limit("10/minute")
async def native_bootstrap_challenge(
    request: Request,
    body: NativeBootstrapChallengeRequest,
    response: Response,
    authorization: str | None = Header(default=None),
    x_firebase_appcheck: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> NativeBootstrapChallengeResponse:
    response.headers["Cache-Control"] = "no-store"

    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Native bootstrap not enabled")

    app_check_token = body.app_check_token or x_firebase_appcheck
    verified = await verify_native_request(
        authorization=authorization,
        app_check_token=app_check_token,
        db=db,
        log_prefix="auth.native_bootstrap.challenge",
    )

    try:
        installation_uuid = uuid.UUID(body.installation_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown installation")

    installation = await db.get(DeviceInstallation, installation_uuid)
    # 존재하지 않음/타인 소유/미활성/project 불일치 — 전부 동일하게 401(enumeration 방지,
    # native_bootstrap.py 소비부 기존 관례와 동일).
    if (
        installation is None
        or installation.user_id != verified.user_id
        or installation.status != "active"
        or installation.project_id != settings.firebase_project_id
    ):
        logger.warning("auth.native_bootstrap.challenge rejected reason=installation_not_eligible")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown installation")

    try:
        issued = await issue_challenge(
            db,
            purpose=PURPOSE_BOOTSTRAP_ISSUE,
            user_id=verified.user_id,
            firebase_uid=verified.firebase_uid,
            project_id=settings.firebase_project_id,
            tenant_id=None,
            environment=installation.environment,
            platform=installation.platform,
            app_id=installation.app_id,
            http_method="POST",
            route="/api/v2/auth/native-bootstrap",
            web_origin=str(request.base_url).rstrip("/"),
            ttl_seconds=TTL_BOOTSTRAP_ISSUE_SECONDS,
            installation_id=installation.id,
            key_version=installation.key_version,
        )
    except ChallengeAlreadyActiveError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Bootstrap challenge already active")

    logger.info("auth.native_bootstrap.challenge success")
    return NativeBootstrapChallengeResponse(
        challenge_id=issued.challenge_id,
        client_data_b64url=issued.client_data_b64url,
        expires_in=TTL_BOOTSTRAP_ISSUE_SECONDS,
    )
