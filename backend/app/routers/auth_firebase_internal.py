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

import base64
import binascii
import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.models.auth_identity import AuthIdentity, AuthMigration
from app.models.device_installation import DeviceInstallation
from app.models.user import User
from app.services.android_key_attestation import AndroidAttestationVerificationError, verify_bootstrap_signature
from app.services.apple_app_attest import AppAttestVerificationError, verify_assertion
from app.services.auth_cutover import is_before_cutover
from app.services.device_proof import (
    PURPOSE_BOOTSTRAP_REDEEM,
    ChallengeVerificationError,
    atomic_bump_installation_counter,
    consume_device_proof_challenge,
    sha256_hex,
    verify_challenge_binding,
)
from app.services.firebase_session_mint import mint_session_cookie, mint_session_cookie_for_uid
from app.services.firebase_verifier import verify_firebase_id_token
from app.services.native_bootstrap import consume_bootstrap_code
from app.services.oauth_handoff import DEFAULT_TTL_SECONDS as OAUTH_HANDOFF_TTL_SECONDS
from app.services.oauth_handoff import consume_handoff_code, generate_handoff_code, issue_handoff_code


def _b64_decode(value: str | None) -> bytes | None:
    if value is None:
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/auth", tags=["auth", "firebase", "internal"])

_AUTH_TIME_MAX_AGE_SECONDS = 5 * 60  # doc §4.4 3단계: now - auth_time <= 5분


class FirebaseSessionMintRequest(BaseModel):
    id_token: str


class FirebaseSessionMintResponse(BaseModel):
    session_cookie: str
    expires_in: int


# 산티아고 §9 finding 4(HIGH, 2026-07-15): 최초 구현이 cron.py CRON_SECRET 패턴을 그대로
# 따라 "시크릿 미설정=허용"이었는데, cron과 달리 이 엔드포인트는 세션쿠키 mint 능력 자체라
# 환경 무관 fail-open이 위험하다 — 직접 probe로 `app_env=production`+시크릿 미설정 시
# 내부 consume/mint 엔드포인트가 공개됨을 실증. non-local 환경은 fail-closed(503), 로컬
# 개발(APP_ENV=development)만 예외 허용.
_LOCAL_ENVS = {"development"}


def _really_local() -> bool:
    """story #2071(critical, 2026-07-21) 근본수정 — `app_env=="development"`는 "진짜 로컬"과
    "인터넷에 노출된 dev Cloud Run 배포"를 구분 못 한다(둘 다 APP_ENV=development로 배포됨).
    산티아고 #2202(07-15)의 완화("Firebase 기능 default-off면 시크릿 startup 요구 면제")가
    이 구분 부재와 겹쳐 노출된 dev를 그대로 열어버렸다 — `FIREBASE_BFF_INTERNAL_SECRET`이
    dev에 안 배선된 채 이 fail-open이 dev에도 적용됨(민군 발견·오르테가군 실측 확定).

    Cloud Run은 `K_SERVICE`를 항상 자동 주입한다(설정 불필요 — `app/core/database.py`의
    커넥션 태깅과 동일 SSOT, 신규 발명 아님). 이게 없으면(로컬 `uvicorn`/pytest) 진짜 로컬,
    있으면(dev든 prod든) Cloud Run 위 — 인터넷에 닿을 수 있으니 fail-open 대상이 아니다."""
    return not os.environ.get("K_SERVICE")


def _require_internal_secret(authorization: str | None) -> None:
    secret = settings.firebase_bff_internal_secret
    if not secret:
        if settings.app_env in _LOCAL_ENVS and _really_local():
            return  # 진짜 로컬 개발 전용 예외(Cloud Run 위가 아님)
        logger.warning(
            "auth.firebase.internal_secret_missing_in_non_local_env app_env=%s on_cloud_run=%s",
            settings.app_env, not _really_local(),
        )
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service misconfigured")
    if authorization != f"Bearer {secret}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal credential")


def check_internal_secret_config(s=None) -> None:
    """fail-closed(산티아고 §9 finding 4): non-local 환경에서 시크릿 미설정이면 startup
    차단(check_listen_config()와 동일 패턴, main lifespan이 호출).

    ⚠️산티아고 #2202 재검토(2026-07-15) 배포 회귀 발견·즉시 fix: 최초 구현이 Firebase
    기능 플래그와 무관하게 non-local이면 무조건 시크릿을 요구해서, **Firebase 전부
    default-off인 지금 상태로 배포해도**(`deploy_backend.sh`가 아직
    `FIREBASE_BFF_INTERNAL_SECRET`을 SECRETS_SPEC에 배선하지 않음) backend 전체가
    startup에서 죽는 회귀였다(직접 probe: prod_features_off_missing_secret_startup_
    allowed=False). 이 내부 엔드포인트를 실제로 쓰는 기능(세션 발급/모바일 부트스트랩)이
    켜져 있을 때만 시크릿을 요구한다.

    story #2071(critical) 근본수정: `app_env not in _LOCAL_ENVS`만으로는 노출된 dev
    Cloud Run(APP_ENV=development)을 놓친다 — `_really_local()`(K_SERVICE 부재) 아니면
    시크릿을 요구한다. dev에 Firebase 기능이 켜지고 이 startup 가드가 살아 있으면, 시크릿
    없이는 이제 배포 자체가 실패한다(런타임 503 fail-closed보다 먼저 잡힘 — 배포 시점에
    시끄럽게 실패하는 쪽이 더 안전, check_listen_config()와 동형)."""
    if s is None:
        from app.core.config import settings as s
    firebase_internal_enabled = (
        s.firebase_auth_issue_session or s.firebase_auth_mobile_issue or s.firebase_oauth_handoff_enabled
    )
    _not_local = s.app_env not in _LOCAL_ENVS or not _really_local()
    if firebase_internal_enabled and _not_local and not s.firebase_bff_internal_secret:
        raise RuntimeError(
            f"APP_ENV={s.app_env}인데 FIREBASE_BFF_INTERNAL_SECRET 미설정 — 내부 세션 mint/"
            "consume 엔드포인트가 인증 없이 공개된다(fail-closed·산티아고 §9 finding 4·"
            "story #2071 K_SERVICE 판정 포함)."
        )


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

    # 산티아고 #2206 갱신 재검토(2026-07-16): 이 엔드포인트는 5분 freshness만 보고 migration
    # state/cutover epoch를 전혀 안 봤다(§17d-1 위반) — native issue와 동일 guard를
    # session-cookie mint 전에도 강제. reset_required/rollback_hold나 revoke 이후 예전 ID
    # token으로도 여기선 세션쿠키가 그대로 발급될 수 있었다.
    auth_time_dt = datetime.fromtimestamp(verified.auth_time, tz=timezone.utc)
    migration = await db.get(AuthMigration, identity_row.user_id)
    if migration is None or migration.state not in ("provisioning", "firebase"):
        logger.warning("auth.firebase.session_mint rejected reason=ineligible_migration_state")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not eligible")
    if is_before_cutover(migration.auth_valid_after, auth_time_dt):
        logger.warning("auth.firebase.session_mint rejected reason=before_cutover")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    valid_duration_seconds = 5 * 24 * 60 * 60
    session_cookie = await mint_session_cookie(
        body.id_token, settings.firebase_project_id, valid_duration_seconds
    )
    if session_cookie is None:
        logger.warning("auth.firebase.session_mint failed reason=mint_failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Session cookie mint failed")

    # native consume과 동일 이유(Firebase 네트워크 왕복 중 revoke TOCTOU) — cookie 반환 직전
    # 세 번째 authoritative 재조회. 실패 시 이미 mint된 cookie는 반환하지 않는다.
    migration_after_mint = await db.get(AuthMigration, identity_row.user_id, populate_existing=True)
    if (
        migration_after_mint is None
        or migration_after_mint.state not in ("provisioning", "firebase")
        or is_before_cutover(migration_after_mint.auth_valid_after, auth_time_dt)
    ):
        logger.warning("auth.firebase.session_mint rejected reason=revoked_during_mint")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    logger.info("auth.firebase.session_mint success")
    return FirebaseSessionMintResponse(session_cookie=session_cookie, expires_in=valid_duration_seconds)


class NativeBootstrapConsumeRequest(BaseModel):
    code: str
    installation_id: str
    challenge_id: str  # bootstrap_redeem 챌린지
    client_data_b64url: str
    key_version: int
    # iOS: App Attest assertion CBOR. Android: Keystore ECDSA-SHA256 signature(raw).
    assertion_b64: str | None = None
    signature_b64: str | None = None
    # 산티아고 §9 finding 3(HIGH) 최소 반영(④⑤): 호출부(Next.js BFF)가 이미 유효한
    # __Host-sp_fs 세션을 갖고 있으면 그 세션의 검증된 user_id를 넘긴다 — attacker가 자기
    # code를 피해자 WebView에서 열게 만들어도(login-CSRF) 기존 세션 사용자와 code의
    # 소유자가 다르면 무조건 거부한다(조용한 account-switch 금지).
    existing_session_user_id: str | None = None


class NativeBootstrapConsumeResponse(BaseModel):
    session_cookie: str
    expires_in: int


@router.post("/native-bootstrap/consume", response_model=NativeBootstrapConsumeResponse)
async def consume_native_bootstrap(
    body: NativeBootstrapConsumeRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> NativeBootstrapConsumeResponse:
    """story 4dee942b(Phase1-S5)+story cbd578d4(C4·§7.5): Next.js `/auth/native` 라우트(FE
    lane)가 exact-origin POST body로 호출하는 내부 atomic-consume API — §7.5의 2단계
    (redeem) 절반. native가 issue 단계에서 받은 redeem `client_data_b64url`을 설치 키로
    재-assert한 걸 여기서 검증하고, **단일 트랜잭션**에서 6개 조건부 mutation 전부 성공해야
    한다: installation active+key_version 일치·redeem challenge unused/unexpired+binding
    일치·counter CAS·bootstrap code atomic consume·challenge atomic consume. 하나라도
    실패하면 전체 rollback+401. mint(Firebase 왕복)는 커밋 후, DB lock 밖에서 수행."""
    _require_internal_secret(authorization)

    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Native bootstrap not enabled")

    try:
        installation_uuid = uuid.UUID(body.installation_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    installation = await db.get(DeviceInstallation, installation_uuid)
    if (
        installation is None
        or installation.status != "active"
        or installation.key_version != body.key_version
        or installation.project_id != settings.firebase_project_id
    ):
        logger.warning("auth.native_bootstrap.consume rejected reason=installation_not_eligible")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    try:
        binding = await verify_challenge_binding(
            db,
            challenge_id=body.challenge_id,
            client_data_b64url_value=body.client_data_b64url,
            purpose=PURPOSE_BOOTSTRAP_REDEEM,
            expected_user_id=installation.user_id,
            expected_app_id=installation.app_id,
            expected_platform=installation.platform,
            expected_environment=installation.environment,
            expected_installation_id=str(installation.id),
        )
    except ChallengeVerificationError:
        logger.warning("auth.native_bootstrap.consume rejected reason=redeem_challenge_binding_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    if binding.challenge.key_version != body.key_version:
        logger.warning("auth.native_bootstrap.consume rejected reason=key_version_mismatch")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    # §7.5: redeem transcript가 애초에 발급 시점에 이 정확한 code의 SHA256에 바인딩됐어야
    # 한다(다른 code의 redeem transcript를 재사용하는 걸 차단) — 정직한 401(사유 비노출).
    if binding.transcript.get("bootstrap_code_sha256") != sha256_hex(body.code.encode()):
        logger.warning("auth.native_bootstrap.consume rejected reason=code_binding_mismatch")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

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
        logger.warning("auth.native_bootstrap.consume rejected reason=assertion_invalid detail=%s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    # §7.5 원자 6조건 트랜잭션 — 하나라도 0-row면 전체 rollback.
    consumed = await consume_bootstrap_code(
        db, code=body.code, project_id=settings.firebase_project_id, installation_id=installation.id, commit=False,
    )
    if consumed is None or consumed.redeem_challenge_id != binding.challenge.id:
        await db.rollback()
        logger.warning("auth.native_bootstrap.consume rejected reason=code_consume_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    challenge_consumed = await consume_device_proof_challenge(
        db, challenge_id=binding.challenge.id, purpose=PURPOSE_BOOTSTRAP_REDEEM
    )
    if not challenge_consumed:
        await db.rollback()
        logger.warning("auth.native_bootstrap.consume rejected reason=redeem_challenge_consume_race")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    counter_bumped = await atomic_bump_installation_counter(
        db, installation_id=installation.id, field=counter_field, new_value=new_counter
    )
    if not counter_bumped:
        await db.rollback()
        logger.warning("auth.native_bootstrap.consume rejected reason=counter_cas_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    # installation active+key_version을 트랜잭션 안에서 한 번 더(강제 재조회) — 위 preamble
    # 조회~여기 사이에 revoke될 수 있는 창을 좁힌다(Story A TOCTOU 교훈과 동일 원리).
    installation_at_commit = await db.get(DeviceInstallation, installation.id, populate_existing=True)
    if (
        installation_at_commit is None
        or installation_at_commit.status != "active"
        or installation_at_commit.key_version != body.key_version
    ):
        await db.rollback()
        logger.warning("auth.native_bootstrap.consume rejected reason=installation_revoked_before_commit")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    await db.commit()

    if body.existing_session_user_id and body.existing_session_user_id != str(consumed.user_id):
        logger.warning("auth.native_bootstrap.consume rejected reason=session_user_mismatch")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session user mismatch")

    # finding 6: consume-time 재검증 — 발급 시점 검증(user active+identity linked)이 최대
    # 45초 전이라 그 사이 상태 변화(계정 비활성화/identity unlink)를 반드시 다시 본다.
    post_consume_user = await db.get(User, consumed.user_id)
    if post_consume_user is None or not post_consume_user.is_active:
        logger.warning("auth.native_bootstrap.consume rejected reason=user_inactive_at_consume")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    # 산티아고 #2202 3차 재검토(2026-07-15) 잔여 2: (issuer,subject)만 보고 unlinked 여부만
    # 확인하면 그 사이 identity가 **다른 user_id로 재연결**된 레이스를 못 잡는다(구 행
    # unlink+동일 firebase_uid로 신규 행이 다른 사용자에게 연결돼도 partial-unique 제약은
    # 통과) — consumed.user_id와 정확히 같은 행인지까지 재확認.
    still_linked = (
        await db.execute(
            select(AuthIdentity.id).where(
                AuthIdentity.issuer == f"https://securetoken.google.com/{settings.firebase_project_id}",
                AuthIdentity.subject == consumed.firebase_uid,
                AuthIdentity.user_id == consumed.user_id,
                AuthIdentity.unlinked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if still_linked is None:
        logger.warning("auth.native_bootstrap.consume rejected reason=identity_unlinked_at_consume")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identity no longer linked")

    # 산티아고 #2202 3차 재검토 잔여 2(HIGH): AuthMigration.state 검증 없이는
    # reset_required/rollback_hold 사용자가 bootstrap custom-token으로 새 세션을 발급받아
    # coordinated forced-reset 정책(doc §6.1)과 정면 충돌한다. auth_migrations 행이 없거나
    # (Phase 3 cohort 미편입) provisioning/firebase 상태가 아니면 거부 — fail-closed.
    migration = await db.get(AuthMigration, consumed.user_id)
    if migration is None or migration.state not in ("provisioning", "firebase"):
        logger.warning(
            "auth.native_bootstrap.consume rejected reason=ineligible_migration_state state=%s",
            migration.state if migration else None,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not eligible for Firebase session")

    # 산티아고 #2202 3차 재검토 orphan finding + BLOCKER 2 시정(story bea25062·2026-07-16):
    # 이전엔 consumed.created_at(코드 발급 시각)을 cutover epoch와 비교했는데, revoke 이후에도
    # 예전(pre-cutover) Firebase ID token으로 여전히 새 코드를 "발급"받을 수 있었다(당시 issue
    # 엔드포인트가 cutover를 안 봤다) — created_at은 revoke보다 늦지만 그 코드의 근거가 된
    # 실제 인증(auth_time)은 revoke 이전이라 우회가 가능했다. 이제 issue 엔드포인트도 발급
    # 시점에 cutover를 검사하지만(방어 심화), 여기 consume 재검증은 항상 원본 auth_time
    # 기준으로 다시 본다 — 발급~소비 사이(최대 45초)에 새로 revoke가 발생했을 수 있어서다.
    # auth_time이 없으면(데이터 무결성 문제) fail-closed.
    if consumed.auth_time is None:
        logger.warning("auth.native_bootstrap.consume rejected reason=missing_auth_time")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    if is_before_cutover(migration.auth_valid_after, consumed.auth_time):
        logger.warning("auth.native_bootstrap.consume rejected reason=revoked_after_issuance")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    # 산티아고 RED 조건 ⑤(consume/mint 중간 revoke TOCTOU): 위 검사와 실제 mint(Firebase
    # 네트워크 왕복 포함) 사이에도 revoke가 끼어들 수 있다 — mint 직전에 migration을 다시
    # 읽어 동일 기준(state+원본 auth_time)으로 재확인해 창을 최대한 좁힌다. 별도 revoke
    # 트랜잭션과 이 요청 사이의 완전한 원자성은 분산 락 없이는 불가능하지만, 재확인 시점을
    # mint 직전까지 당겨 잔여 창을 실질적으로 최소화한다.
    # ⚠️자체 발견: `Session.get()`은 동일 세션의 identity map에 이미 로드된 행이면 SQL을
    # 아예 다시 안 날리고 캐시된 in-memory 객체를 그대로 반환한다(문서화된 기본 동작) — 위
    # 첫 `migration` 조회와 같은 PK라 `populate_existing=True` 없인 이 재확인이 완전히
    # 무력한 no-op이 된다(재조회처럼 보이지만 실제론 DB를 안 건드림). 반드시 강제 재조회.
    migration_at_mint = await db.get(AuthMigration, consumed.user_id, populate_existing=True)
    if (
        migration_at_mint is None
        or migration_at_mint.state not in ("provisioning", "firebase")
        or is_before_cutover(migration_at_mint.auth_valid_after, consumed.auth_time)
    ):
        logger.warning("auth.native_bootstrap.consume rejected reason=revoked_before_mint")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    valid_duration_seconds = 5 * 24 * 60 * 60
    session_cookie = await mint_session_cookie_for_uid(
        consumed.firebase_uid, settings.firebase_project_id, settings.firebase_web_api_key, valid_duration_seconds
    )
    if session_cookie is None:
        logger.warning("auth.native_bootstrap.consume failed reason=mint_failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Session cookie mint failed")

    # 산티아고 #2206 갱신 재검토(2026-07-16) — mint 직전 재확인만으론 여전히 Firebase 네트워크
    # 왕복(custom-token 발급→signInWithCustomToken→createSessionCookie, 수백ms~초 단위) 도중의
    # revoke를 못 잡는다(probe: revoke_during_mint_cookie_returned=True). 분산 락 없이 이 창을
    # 완전히 닫는 산티아고의 정확한 해법 — **cookie를 반환하기 직전 세 번째 authoritative
    # 재조회**. revoke가 mint 이전/도중에 커밋됐으면 이 조회가 잡고, 만에 하나 이 조회 "이후"에
    # revoke가 커밋되더라도 방금 mint된 Firebase 세션쿠키 자체의 auth_time은 여전히 revoke
    # 이전이므로 이후 모든 요청에서 통상 verifier(`_resolve_firebase_session`)가 거부한다 —
    # 즉 네트워크 구간 전체가 이 시점 기준으로 닫힌다. 재확인 실패 시 이미 mint된 cookie는
    # 폐기(반환하지 않는다 — Firebase 측에 남은 세션 자체는 최초 auth_valid_after 갱신 시의
    # best-effort user-wide revoke가 이미 정리를 시도했었고, 로컬이 어차피 이 값을 안 돌려주면
    # 클라이언트가 쓸 수 없다).
    migration_after_mint = await db.get(AuthMigration, consumed.user_id, populate_existing=True)
    if (
        migration_after_mint is None
        or migration_after_mint.state not in ("provisioning", "firebase")
        or is_before_cutover(migration_after_mint.auth_valid_after, consumed.auth_time)
    ):
        logger.warning("auth.native_bootstrap.consume rejected reason=revoked_during_mint")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    logger.info("auth.native_bootstrap.consume success")
    return NativeBootstrapConsumeResponse(session_cookie=session_cookie, expires_in=valid_duration_seconds)


# story 1931(계약 doc e-mobile-oauth-native-handoff-contract §4/§7.5(b)): OAuth 완결→웹뷰
# 세션 핸드오프 — 위 attested native-bootstrap(§7.5, installation/challenge/counter 바인딩)
# 과 물리적으로 분리된 경량 issue/consume. 코드는 PKCE code_challenge에 바인딩되고, 원자
# 소비 시 code_verifier로 재계산한 challenge와 일치해야 한다(oauth_handoff.py).
#
# ⚠️미르코 실측 정정(2026-07-16, 산티아고 §10 재확認 조건부 승인): 실 라이브 web OAuth
# (`app/routers/auth.py:990 oauth_callback()`)는 Firebase 무접촉 — 레거시 self-issued
# JWT(`create_tokens()`)만 발급한다. 그래서 이 흐름도 Firebase id_token 검증이 아니라
# BFF가 `oauth_callback()`으로 이미 해소한 user_id를 그대로 신뢰(내부시크릿이 신뢰 근거,
# mint_firebase_session/consume_native_bootstrap과 동형)하고, consume은 레거시
# access/refresh 토큰 쌍을 mint한다.
_OAUTH_HANDOFF_MIN_CHALLENGE_LEN = 43  # base64url(SHA256) 무패딩 최소 길이(RFC 7636)


class OAuthHandoffIssueRequest(BaseModel):
    # 산티아고 §10.1.2 계열 defense-in-depth: 이 내부 엔드포인트는 BFF 전용이라 공개 공격면은
    # 아니지만, 스키마가 정의한 두 필드 외 어떤 것도 조용히 무시하지 않는다(§10.6 음성테스트 7과
    # 동일 원칙 — "무시 아님, 거부").
    model_config = ConfigDict(extra="forbid")

    user_id: str  # BFF가 oauth_callback()으로 이미 해소한 서버-확定 subject.
    code_challenge: str  # PKCE S256 = base64url(SHA256(code_verifier)), 패딩 없음


class OAuthHandoffIssueResponse(BaseModel):
    code: str
    expires_in: int


@router.post("/oauth-handoff/issue", response_model=OAuthHandoffIssueResponse)
async def issue_oauth_handoff(
    body: OAuthHandoffIssueRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> OAuthHandoffIssueResponse:
    """Next.js BFF(`?native=1` OAuth 콜백 분기)가 `oauth_callback()` 성공 직후 호출 — 셸이
    OAuth-start에서 생성한 PKCE code_challenge에 바인딩된 단회 코드를 발급한다. 이 코드는
    쿠키/토큰을 세팅하지 않는다(§3: 콜백 리다이렉트는 code만, mint는 consume에서)."""
    _require_internal_secret(authorization)

    if not settings.firebase_oauth_handoff_enabled:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="OAuth handoff not enabled")

    if len(body.code_challenge) < _OAUTH_HANDOFF_MIN_CHALLENGE_LEN:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code_challenge")

    try:
        user_uuid = uuid.UUID(body.user_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    user = await db.get(User, user_uuid)
    if user is None or not user.is_active:
        logger.warning("auth.oauth_handoff.issue rejected reason=inactive_or_missing_user")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    # 산티아고 §10.8(reset_required+cutover epoch, issue+consume 양시점): 이 발급 자체가
    # "지금 막 완결된" OAuth의 산물이라 reference_time=now — 그래도 발급 순간과 정확히 겹치는
    # revoke 레이스에 대비해 이 시점에도 한 번 확인한다(방어 심화, 필수 차단선은 consume 3중
    # 재검증). `_reject_if_before_cutover`(app/dependencies/auth.py)를 그대로 재사용 —
    # cutover epoch뿐 아니라 `reset_required` state도 함께 거부(§10.8 명시 요구, get_auth_
    # valid_after 단독으론 epoch만 보고 state를 놓쳤던 이전 구현의 갭 수정).
    from app.dependencies.auth import _reject_if_before_cutover

    now = datetime.now(timezone.utc)
    await _reject_if_before_cutover(user_uuid, int(now.timestamp()), db)

    code, code_hash = generate_handoff_code()
    await issue_handoff_code(db, code_hash=code_hash, user_id=user_uuid, code_challenge=body.code_challenge)

    logger.info("auth.oauth_handoff.issue success")
    return OAuthHandoffIssueResponse(code=code, expires_in=OAUTH_HANDOFF_TTL_SECONDS)


class OAuthHandoffConsumeRequest(BaseModel):
    # 산티아고 §10.1.2/§10.6 음성테스트 1·7(MUST, 2026-07-16 조건부 GREEN): 계약 doc §3이
    # 이 스키마를 정확히 `{code, code_verifier}`로 고정 — Firebase assertion/install
    # assertion/ID token/임의 user·install ID 등 다른 어떤 필드도 "무시"가 아니라 요청 자체를
    # 거부해야 한다(extra="forbid"). native consume의 `existing_session_user_id`류 부가 필드를
    # 여기 들여오지 않는다 — 이 흐름은 애초에 기존 세션이 없는 최초 로그인 핸드오프다.
    model_config = ConfigDict(extra="forbid")

    code: str
    code_verifier: str


class OAuthHandoffConsumeResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str
    expires_in: int


# story 1931(산티아고 §10 재확認 조건4): 레거시 JWT엔 assurance 클레임이 없다 — 지금 이걸
# 소비하는 라우트는 없지만(§10.5 seam), OAuth-handoff로 mint된 세션은 항상 이 표식을 달아
# 향후 attestation-gated 기능이 "이 세션은 device-attested가 아니다"를 판별할 수 있게 한다.
_OAUTH_HANDOFF_AUTH_SOURCE = "oauth_handoff"


@router.post("/oauth-handoff/consume", response_model=OAuthHandoffConsumeResponse)
async def consume_oauth_handoff(
    body: OAuthHandoffConsumeRequest,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> OAuthHandoffConsumeResponse:
    """Next.js BFF `/auth/native` 라우트(웹뷰 top-level POST 착지점)가 호출 — PKCE
    code_verifier로 code_challenge를 재계산해 원자 검증+소비하고(단일 쿼리, TOCTOU 없음),
    consume-time 3중 재검증(mint 전·직전·직후 cutover 재확인, native consume과 동형 패턴)을
    거쳐 레거시 access/refresh 토큰 쌍을 mint한다(`oauth_callback()`과 동일 발급 경로 재사용
    — `create_tokens()`+`_store_refresh_token()`). attested §7.5 6조건 트랜잭션과는 완전히
    분리된 경로 — installation/challenge/counter를 전혀 참조하지 않는다."""
    _require_internal_secret(authorization)

    if not settings.firebase_oauth_handoff_enabled:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="OAuth handoff not enabled")

    consumed = await consume_handoff_code(db, code=body.code, code_verifier=body.code_verifier)
    if consumed is None:
        logger.warning("auth.oauth_handoff.consume rejected reason=code_consume_failed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired code")

    user = await db.get(User, consumed.user_id)
    if user is None or not user.is_active:
        logger.warning("auth.oauth_handoff.consume rejected reason=user_inactive_at_consume")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    from app.dependencies.auth import _reject_if_before_cutover

    consumed_ts = int(consumed.created_at.timestamp())
    # §10.8: issue+consume 양시점 재검증. 3중 재확인(mint 전·직전·직후, native consume과
    # 동형 TOCTOU 패턴) — `_reject_if_before_cutover` 재사용으로 reset_required state까지
    # 함께 거부(get_auth_valid_after 단독으론 놓쳤던 갭 수정).
    await _reject_if_before_cutover(consumed.user_id, consumed_ts, db)

    # mint 직전 재확인 — 코드 발급~consume 사이(최대 120초)의 revoke 레이스를 좁힌다.
    await _reject_if_before_cutover(consumed.user_id, consumed_ts, db)

    from datetime import timedelta

    from app.core.security import REFRESH_TOKEN_EXPIRE_DAYS, create_tokens
    from app.routers.auth import _build_app_metadata, _store_refresh_token

    app_metadata = await _build_app_metadata(user, db)
    tokens = create_tokens(
        str(user.id), user.email, app_metadata,
        auth_source=_OAUTH_HANDOFF_AUTH_SOURCE, device_attested=False,
    )
    refresh_expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    await _store_refresh_token(db, user, tokens["refresh_token"], refresh_expires_at)

    # mint 직후(레거시 토큰 서명+RT 저장 커밋 이후) 재확인 — native consume의 "3번째
    # authoritative 재조회"와 동형: mint 도중 revoke가 끼어들었으면 방금 발급한 토큰을 폐기.
    await _reject_if_before_cutover(consumed.user_id, consumed_ts, db)

    logger.info("auth.oauth_handoff.consume success")
    return OAuthHandoffConsumeResponse(
        access_token=tokens["access_token"], refresh_token=tokens["refresh_token"],
        token_type=tokens["token_type"], expires_in=tokens["expires_in"],
    )
