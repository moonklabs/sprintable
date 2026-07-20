"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.3): 설치 등록 챌린지 발급 + story cbd578d4(C4·§7.3): register 본체 배선.

기본 비활성(`firebase_auth_mobile_issue=False`가 모든 non-test 환경 기본값) — S1~S5·Story A와
동일 패턴."""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import limiter
from app.core.security import verify_totp
from app.dependencies.database import get_db
from app.models.device_installation import DeviceInstallation
from app.models.user import User
from app.services.android_key_attestation import AndroidAttestationVerificationError, verify_key_attestation
from app.services.apple_app_attest import AppAttestVerificationError, verify_attestation
from app.services.device_proof import (
    PURPOSE_REGISTER,
    TTL_REGISTER_SECONDS,
    ChallengeAlreadyActiveError,
    ChallengeVerificationError,
    consume_device_proof_challenge,
    issue_challenge,
    verify_challenge_binding,
)
from app.services.native_request_auth import verify_native_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/auth/device-installations", tags=["auth", "firebase", "mobile", "device-install"])


def _b64_decode(value: str | None) -> bytes | None:
    if value is None:
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


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


# story cbd578d4(C4·§7.3): register 본체. 최초 등록 3증거 — ①verify_native_request()가
# 이미 강제하는 최근 Firebase 재인증(auth_time<=5m)+exact UID/project mapping ②동일 함수의
# exact App Check ③아래에서 검증하는, 서버 challenge에 바인딩된 platform attestation이
# 추출한 public key(C2/C3 verifier). client가 보낸 공개키는 절대 신뢰 안 함 — leaf 인증서/
# credential에서 서버가 직접 뽑은 값만 저장한다.
class RegisterRequest(BaseModel):
    challenge_id: str
    client_data_b64url: str
    app_check_token: str | None = None
    platform: str  # ios|android
    app_id: str
    environment: str
    # iOS
    key_id_b64: str | None = None
    attestation_object_b64: str | None = None
    # Android
    certificate_chain_b64: list[str] | None = None
    play_integrity_token: str | None = None
    # §7.3: bounded N 초과 시에만 필요.
    mfa_code: str | None = None


class RegisterResponse(BaseModel):
    installation_id: str
    key_version: int
    security_level: str | None = None


@router.post("/register", response_model=RegisterResponse)
@limiter.limit("10/minute")
async def register_device_installation(
    request: Request,
    body: RegisterRequest,
    response: Response,
    authorization: str | None = Header(default=None),
    x_firebase_appcheck: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> RegisterResponse:
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
        log_prefix="auth.device_installations.register",
    )
    # ⚠️자체 발견: App Check의 app_id(sub claim, Firebase App ID 형식 "1:proj:ios:hash")와
    # body.app_id(=bundle ID/package name, verify_attestation의 expected_bundle_id로 쓰임)는
    # 서로 다른 식별자 네임스페이스라 절대 같을 수 없다 — 애초에 동일 값 비교는 잘못된
    # 체크였다(실 프로덕션에서 항상 실패했을 버그). App Check 신뢰성 자체는
    # verify_native_request()의 allowlist 검증으로 이미 충분 — 여기선 비교하지 않는다.

    try:
        binding = await verify_challenge_binding(
            db,
            challenge_id=body.challenge_id,
            client_data_b64url_value=body.client_data_b64url,
            purpose=PURPOSE_REGISTER,
            expected_user_id=verified.user_id,
            expected_app_id=body.app_id,
            expected_platform=body.platform,
            expected_environment=body.environment,
        )
    except ChallengeVerificationError:
        logger.warning("auth.device_installations.register rejected reason=challenge_binding_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge")

    client_data_hash = hashlib.sha256(binding.transcript_bytes).digest()

    # §7.3: 사용자당 bounded N개 active installation — 초과는 fresh re-auth(verify_native_
    # request가 이미 5분 이내로 강제)+MFA(TOTP 미등록 사용자는 그냥 거부 — fail-closed).
    active_count = (
        await db.execute(
            select(func.count(DeviceInstallation.id)).where(
                DeviceInstallation.user_id == verified.user_id, DeviceInstallation.status == "active"
            )
        )
    ).scalar_one()
    if active_count >= settings.device_installation_max_active_per_user:
        user = await db.get(User, verified.user_id)
        if (
            user is None
            or not user.totp_enabled
            or not body.mfa_code
            or not verify_totp(user.totp_secret or "", body.mfa_code)
        ):
            logger.warning("auth.device_installations.register rejected reason=installation_cap_mfa_required")
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Installation limit reached — MFA required"
            )

    try:
        if body.platform == "ios":
            attestation_object = _b64_decode(body.attestation_object_b64)
            key_id = _b64_decode(body.key_id_b64)
            if attestation_object is None or key_id is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing attestation payload")
            verified_attestation = verify_attestation(
                attestation_object=attestation_object,
                key_id=key_id,
                client_data_hash=client_data_hash,
                expected_team_id=settings.ios_team_id,
                expected_bundle_id=body.app_id,
                expected_environment=body.environment,
            )
            public_key_der = verified_attestation.public_key_der
            key_id_hex = key_id.hex()
            attestation_type = "app_attest"
            attestation_environment = verified_attestation.environment
            security_level = None
            release_cert_digest = None
        else:
            raw_chain = body.certificate_chain_b64 or []
            chain_der = [c for c in (_b64_decode(c) for c in raw_chain) if c is not None]
            if not chain_der or len(chain_der) != len(raw_chain):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing attestation payload")
            if not body.play_integrity_token:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Play Integrity token")
            expected_cert_digest = bytes.fromhex(settings.android_signing_cert_digest_sha256_hex or "")
            verified_key_attestation = verify_key_attestation(
                certificate_chain=chain_der,
                expected_challenge=client_data_hash,
                expected_package_name=body.app_id.encode(),
                expected_signing_cert_digest=expected_cert_digest,
            )
            from app.services.play_integrity import PlayIntegrityVerificationError, verify_play_integrity_token

            try:
                await verify_play_integrity_token(
                    integrity_token=body.play_integrity_token,
                    expected_package_name=body.app_id,
                    expected_cert_sha256_digest_b64=base64.b64encode(expected_cert_digest).decode(),
                    minimum_version_code=settings.android_min_version_code,
                    request_hash=base64.b64encode(client_data_hash).decode(),
                )
            except PlayIntegrityVerificationError as exc:
                logger.warning("auth.device_installations.register rejected reason=play_integrity_invalid detail=%s", exc)
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Play Integrity token")

            public_key_der = verified_key_attestation.public_key_der
            key_id_hex = hashlib.sha256(public_key_der).hexdigest()
            attestation_type = "key_attestation"
            attestation_environment = body.environment
            security_level = verified_key_attestation.security_level
            release_cert_digest = settings.android_signing_cert_digest_sha256_hex
    except (AppAttestVerificationError, AndroidAttestationVerificationError) as exc:
        logger.warning("auth.device_installations.register rejected reason=attestation_invalid detail=%s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid attestation")

    # 원자 트랜잭션: challenge 소비+installation 행 생성이 같은 커밋 안에 있어야 한다 —
    # 소비 실패(레이스로 이미 소비/만료)면 installation도 절대 만들어지면 안 된다.
    consumed = await consume_device_proof_challenge(db, challenge_id=binding.challenge.id, purpose=PURPOSE_REGISTER)
    if not consumed:
        await db.rollback()
        logger.warning("auth.device_installations.register rejected reason=challenge_consume_race")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge")

    now = datetime.now(timezone.utc)
    installation = DeviceInstallation(
        user_id=verified.user_id,
        firebase_uid=verified.firebase_uid,
        project_id=settings.firebase_project_id,
        tenant_id=None,
        environment=body.environment,
        platform=body.platform,
        app_id=body.app_id,
        release_cert_digest=release_cert_digest,
        key_version=1,
        key_id=key_id_hex,
        public_key_fingerprint=hashlib.sha256(public_key_der).hexdigest(),
        public_key_der=public_key_der,
        attestation_type=attestation_type,
        attestation_environment=attestation_environment,
        security_level=security_level,
        status="active",
        attested_at=now,
        created_at=now,
    )
    db.add(installation)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        logger.warning("auth.device_installations.register rejected reason=duplicate_key_fingerprint")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Installation already registered")

    logger.info("auth.device_installations.register success platform=%s", body.platform)
    return RegisterResponse(installation_id=str(installation.id), key_version=1, security_level=security_level)
