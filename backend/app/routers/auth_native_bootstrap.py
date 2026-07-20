"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5)+story cbd578d4(C4·§7.0/§7.5): `POST
/api/v2/auth/native-bootstrap` — 네이티브 모바일 앱이 WebView 밖에서 직접 호출(공개 API,
쿠키 인증 아님).

⚠️§7.0 명시 삭제: 원래 S5 구현(App Check 앱 무결성 + client-supplied install hint 조합으로
`device_binding_hash` 구성 — "완전한 암호학적 per-device 증명은 아니다"라고 정직 표기했던
바로 그 임시 스킴)을 이 엔드포인트가 완전히 대체한다. 이제는 §7.5 2단계 원자 트랜잭션의
1단계 — native가 이미 등록된 설치의 `bootstrap_issue` 챌린지를 Keystore/Secure Enclave
private key로 assert하면, 서버가 그 챌린지를 원자 소비하면서 **같은 트랜잭션**에 hashed
one-time code+`bootstrap_redeem` 챌린지를 함께 생성한다."""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import limiter
from app.dependencies.database import get_db
from app.models.device_installation import DeviceInstallation
from app.services.android_key_attestation import AndroidAttestationVerificationError, verify_bootstrap_signature
from app.services.apple_app_attest import AppAttestVerificationError, verify_assertion
from app.services.device_proof import (
    PURPOSE_BOOTSTRAP_ISSUE,
    PURPOSE_BOOTSTRAP_REDEEM,
    TTL_BOOTSTRAP_ISSUE_SECONDS,
    TTL_BOOTSTRAP_REDEEM_SECONDS,
    ChallengeAlreadyActiveError,
    ChallengeVerificationError,
    atomic_bump_installation_counter,
    consume_device_proof_challenge,
    issue_challenge,
    verify_challenge_binding,
)
from app.services.native_bootstrap import DEFAULT_TTL_SECONDS, generate_bootstrap_code, issue_bootstrap_code
from app.services.native_request_auth import verify_native_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/auth", tags=["auth", "firebase", "mobile"])


def _b64_decode(value: str | None) -> bytes | None:
    if value is None:
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


class NativeBootstrapRequest(BaseModel):
    app_check_token: str | None = None
    installation_id: str
    challenge_id: str
    client_data_b64url: str
    # iOS: App Attest assertion CBOR({signature, authenticatorData}).
    assertion_b64: str | None = None
    # Android: Keystore ECDSA-SHA256 signature over the canonical transcript bytes directly.
    signature_b64: str | None = None


class NativeBootstrapResponse(BaseModel):
    code: str
    expires_in: int
    redeem_challenge_id: str
    redeem_client_data_b64url: str
    redeem_expires_in: int


# 산티아고 §9(2026-07-15) 잔여 하드닝: public issuance는 rate limit 없음 지적 — 로그인류
# 엔드포인트와 동일 임계값(app/routers/auth.py register 패턴 재사용).
@router.post("/native-bootstrap", response_model=NativeBootstrapResponse)
@limiter.limit("10/minute")
async def native_bootstrap(
    request: Request,
    body: NativeBootstrapRequest,
    response: Response,
    authorization: str | None = Header(default=None),
    x_firebase_appcheck: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> NativeBootstrapResponse:
    response.headers["Cache-Control"] = "no-store"  # 산티아고 §9 잔여 하드닝.

    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Native bootstrap not enabled")

    app_check_token = body.app_check_token or x_firebase_appcheck
    verified = await verify_native_request(
        authorization=authorization, app_check_token=app_check_token, db=db, log_prefix="auth.native_bootstrap",
    )

    try:
        installation_uuid = uuid.UUID(body.installation_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown installation")

    installation = await db.get(DeviceInstallation, installation_uuid)
    if (
        installation is None
        or installation.user_id != verified.user_id
        or installation.status != "active"
        or installation.project_id != settings.firebase_project_id
    ):
        logger.warning("auth.native_bootstrap rejected reason=installation_not_eligible")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown installation")

    try:
        binding = await verify_challenge_binding(
            db,
            challenge_id=body.challenge_id,
            client_data_b64url_value=body.client_data_b64url,
            purpose=PURPOSE_BOOTSTRAP_ISSUE,
            expected_user_id=verified.user_id,
            expected_app_id=installation.app_id,
            expected_platform=installation.platform,
            expected_environment=installation.environment,
            expected_installation_id=str(installation.id),
        )
    except ChallengeVerificationError:
        logger.warning("auth.native_bootstrap rejected reason=challenge_binding_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge")

    if binding.challenge.key_version != installation.key_version:
        logger.warning("auth.native_bootstrap rejected reason=key_version_mismatch")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Key version mismatch")

    client_data_hash = hashlib.sha256(binding.transcript_bytes).digest()

    try:
        if installation.platform == "ios":
            assertion = _b64_decode(body.assertion_b64)
            if assertion is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing assertion")
            verified_assertion = verify_assertion(
                assertion=assertion,
                client_data_hash=client_data_hash,
                stored_public_key_der=installation.public_key_der,
                stored_counter=installation.last_sign_count or 0,
                expected_team_id=settings.ios_team_id,
                expected_bundle_id=installation.app_id,
            )
            new_counter = verified_assertion.counter
            counter_field = "last_sign_count"
        else:
            signature = _b64_decode(body.signature_b64)
            if signature is None or binding.challenge.server_seq is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing signature")
            verify_bootstrap_signature(
                signed_bytes=binding.transcript_bytes,
                signature=signature,
                stored_public_key_der=installation.public_key_der,
            )
            new_counter = binding.challenge.server_seq
            counter_field = "last_server_seq"
    except (AppAttestVerificationError, AndroidAttestationVerificationError) as exc:
        logger.warning("auth.native_bootstrap rejected reason=assertion_invalid detail=%s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid assertion")

    # §7.5 원자 트랜잭션: bootstrap_issue 챌린지 소비+counter CAS+코드 생성+redeem 챌린지
    # 생성이 전부 같은 커밋 안에 있어야 한다. 하나라도 실패하면 전체 rollback.
    consumed_challenge = await consume_device_proof_challenge(
        db, challenge_id=binding.challenge.id, purpose=PURPOSE_BOOTSTRAP_ISSUE
    )
    if not consumed_challenge:
        await db.rollback()
        logger.warning("auth.native_bootstrap rejected reason=challenge_consume_race")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired challenge")

    counter_bumped = await atomic_bump_installation_counter(
        db, installation_id=installation.id, field=counter_field, new_value=new_counter
    )
    if not counter_bumped:
        await db.rollback()
        logger.warning("auth.native_bootstrap rejected reason=counter_cas_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Counter replay detected")

    # §7.5: redeem 챌린지의 canonical transcript가 이 코드의 SHA256을 먼저 바인딩해야 하므로
    # (bootstrap_code_sha256 필드) 코드를 챌린지보다 먼저 "생성"한다 — 단 raw code는 아직
    # 어디에도 저장 안 함(generate_bootstrap_code는 순수 함수, DB 무접촉).
    code, code_hash = generate_bootstrap_code()

    try:
        redeem_issued = await issue_challenge(
            db,
            purpose=PURPOSE_BOOTSTRAP_REDEEM,
            user_id=verified.user_id,
            firebase_uid=verified.firebase_uid,
            project_id=settings.firebase_project_id,
            tenant_id=None,
            environment=installation.environment,
            platform=installation.platform,
            app_id=installation.app_id,
            http_method="POST",
            route="/auth/native",
            web_origin=str(request.base_url).rstrip("/"),
            ttl_seconds=TTL_BOOTSTRAP_REDEEM_SECONDS,
            installation_id=installation.id,
            key_version=installation.key_version,
            bootstrap_code_sha256=code_hash,
            commit=False,
        )
    except ChallengeAlreadyActiveError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Redeem challenge already active")

    auth_time_dt = datetime.now(timezone.utc)  # 원본 Firebase ID token auth_time — verify_native_request가 이미 5분 이내로 검증.
    await issue_bootstrap_code(
        db,
        code_hash=code_hash,
        user_id=verified.user_id,
        firebase_uid=verified.firebase_uid,
        project_id=settings.firebase_project_id,
        installation_id=installation.id,
        key_version=installation.key_version,
        redeem_challenge_id=uuid.UUID(redeem_issued.challenge_id),
        ttl_seconds=DEFAULT_TTL_SECONDS,
        auth_time=auth_time_dt,
        commit=False,
    )

    await db.commit()
    logger.info("auth.native_bootstrap success platform=%s", installation.platform)
    return NativeBootstrapResponse(
        code=code,
        expires_in=DEFAULT_TTL_SECONDS,
        redeem_challenge_id=redeem_issued.challenge_id,
        redeem_client_data_b64url=redeem_issued.client_data_b64url,
        redeem_expires_in=TTL_BOOTSTRAP_REDEEM_SECONDS,
    )


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

    # story cbd578d4(C4·§7.4): Android엔 signCount 상당이 없어 서버가 다음 server_seq를
    # 미리 발급해 챌린지에 바인딩한다 — client가 이 값을 서명해 소유권을 증명하고, consume
    # 시점에 atomic_bump_installation_counter()가 CAS로 실제 반영한다. iOS는 client
    # Secure Enclave가 자체 관리하는 signCount를 쓰므로 여기선 server_seq 불필요.
    next_server_seq = (installation.last_server_seq or 0) + 1 if installation.platform == "android" else None

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
            server_seq=next_server_seq,
        )
    except ChallengeAlreadyActiveError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Bootstrap challenge already active")

    logger.info("auth.native_bootstrap.challenge success")
    return NativeBootstrapChallengeResponse(
        challenge_id=issued.challenge_id,
        client_data_b64url=issued.client_data_b64url,
        expires_in=TTL_BOOTSTRAP_ISSUE_SECONDS,
    )
