"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.3): 설치 등록 챌린지 발급. 이 스토리는 발급만 — 실제 등록(register, 플랫폼 attestation
검증 포함)은 C2(iOS)/C3(Android) 검증기 완성 후 C4가 배선한다.

기본 비활성(`firebase_auth_mobile_issue=False`가 모든 non-test 환경 기본값) — S1~S5·Story A와
동일 패턴."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import limiter
from app.dependencies.database import get_db
from app.services.device_proof import (
    PURPOSE_REGISTER,
    TTL_REGISTER_SECONDS,
    ChallengeAlreadyActiveError,
    issue_challenge,
)
from app.services.native_request_auth import verify_native_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/auth/device-installations", tags=["auth", "firebase", "mobile", "device-install"])


class RegistrationChallengeRequest(BaseModel):
    app_check_token: str | None = None
    platform: str  # ios|android
    app_id: str
    environment: str


class RegistrationChallengeResponse(BaseModel):
    challenge_id: str
    client_data_b64url: str
    expires_in: int


@router.post("/registration-challenges", response_model=RegistrationChallengeResponse)
@limiter.limit("10/minute")
async def registration_challenge(
    request: Request,
    body: RegistrationChallengeRequest,
    response: Response,
    authorization: str | None = Header(default=None),
    x_firebase_appcheck: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RegistrationChallengeResponse:
    response.headers["Cache-Control"] = "no-store"

    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Device installation not enabled")

    if body.platform not in ("ios", "android"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported platform")

    app_check_token = body.app_check_token or x_firebase_appcheck
    verified = await verify_native_request(
        authorization=authorization,
        app_check_token=app_check_token,
        db=db,
        log_prefix="auth.device_installations.registration_challenge",
    )

    try:
        issued = await issue_challenge(
            db,
            purpose=PURPOSE_REGISTER,
            user_id=verified.user_id,
            firebase_uid=verified.firebase_uid,
            project_id=settings.firebase_project_id,
            tenant_id=None,
            environment=body.environment,
            platform=body.platform,
            app_id=body.app_id,
            http_method="POST",
            route="/api/v2/auth/device-installations/register",
            web_origin=str(request.base_url).rstrip("/"),
            ttl_seconds=TTL_REGISTER_SECONDS,
        )
    except ChallengeAlreadyActiveError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Registration challenge already active")

    logger.info("auth.device_installations.registration_challenge success")
    return RegistrationChallengeResponse(
        challenge_id=issued.challenge_id,
        client_data_b64url=issued.client_data_b64url,
        expires_in=TTL_REGISTER_SECONDS,
    )
