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
from app.services.firebase_session_mint import mint_session_cookie, mint_session_cookie_for_uid
from app.services.firebase_verifier import verify_firebase_id_token
from app.services.native_bootstrap import consume_bootstrap_code

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


def _require_internal_secret(authorization: str | None) -> None:
    secret = settings.firebase_bff_internal_secret
    if not secret:
        if settings.app_env in _LOCAL_ENVS:
            return  # 로컬 개발 전용 예외
        logger.warning("auth.firebase.internal_secret_missing_in_non_local_env app_env=%s", settings.app_env)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service misconfigured")
    if authorization != f"Bearer {secret}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal credential")


def check_internal_secret_config(s=None) -> None:
    """fail-closed(산티아고 §9 finding 4): non-local 환경에서 시크릿 미설정이면 startup
    차단(check_listen_config()와 동일 패턴, main lifespan이 호출)."""
    if s is None:
        from app.core.config import settings as s
    if s.app_env not in _LOCAL_ENVS and not s.firebase_bff_internal_secret:
        raise RuntimeError(
            f"APP_ENV={s.app_env}인데 FIREBASE_BFF_INTERNAL_SECRET 미설정 — 내부 세션 mint/"
            "consume 엔드포인트가 인증 없이 공개된다(fail-closed·산티아고 §9 finding 4)."
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

    valid_duration_seconds = 5 * 24 * 60 * 60
    session_cookie = await mint_session_cookie(
        body.id_token, settings.firebase_project_id, valid_duration_seconds
    )
    if session_cookie is None:
        logger.warning("auth.firebase.session_mint failed reason=mint_failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Session cookie mint failed")

    logger.info("auth.firebase.session_mint success")
    return FirebaseSessionMintResponse(session_cookie=session_cookie, expires_in=valid_duration_seconds)


class NativeBootstrapConsumeRequest(BaseModel):
    code: str
    device_binding_hash: str | None = None
    # 산티아고 §9 finding 3(HIGH) 최소 반영(④⑤·전체 per-installation attestation은 별도
    # 후속 판단): 호출부(Next.js BFF)가 이미 유효한 __Host-sp_fs 세션을 갖고 있으면 그
    # 세션의 검증된 user_id를 넘긴다 — attacker가 자기 code를 피해자 WebView에서 열게
    # 만들어도(login-CSRF) 기존 세션 사용자와 code의 소유자가 다르면 무조건 거부한다
    # (조용한 account-switch 금지).
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
    """story 4dee942b(Phase1-S5): Next.js `/auth/native?code=` 라우트(FE lane)가 호출하는
    내부 atomic-consume API. 원본 Firebase ID token은 발급 순간 이후로 존재하지 않으므로
    firebase_uid만으로 custom token 경유 세션쿠키를 새로 mint한다(S4 mint_session_cookie
    재사용, 오르테가군 판정). 실패 사유(만료/재사용/불일치)는 전부 동일한 401로 통일.

    ⚠️산티아고 §9 검토(2026-07-15) finding 6 반영: atomic consume 성공만으로 곧장 mint하지
    않는다 — 코드 발급~소비 사이(최대 45초)에 계정이 비활성화되거나 identity가 unlink됐을
    수 있어 **소비 직후 다시** user.is_active/identity.unlinked_at을 재확認한다."""
    _require_internal_secret(authorization)

    if not settings.firebase_auth_mobile_issue:
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail="Native bootstrap not enabled")

    consumed = await consume_bootstrap_code(
        db,
        code=body.code,
        project_id=settings.firebase_project_id,
        device_binding_hash=body.device_binding_hash,
    )
    if consumed is None:
        logger.warning("auth.native_bootstrap.consume rejected reason=invalid_expired_or_replayed")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired bootstrap code")

    if body.existing_session_user_id and body.existing_session_user_id != str(consumed.user_id):
        logger.warning("auth.native_bootstrap.consume rejected reason=session_user_mismatch")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session user mismatch")

    # finding 6: consume-time 재검증 — 발급 시점 검증(user active+identity linked)이 최대
    # 45초 전이라 그 사이 상태 변화(계정 비활성화/identity unlink)를 반드시 다시 본다.
    post_consume_user = await db.get(User, consumed.user_id)
    if post_consume_user is None or not post_consume_user.is_active:
        logger.warning("auth.native_bootstrap.consume rejected reason=user_inactive_at_consume")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")

    still_linked = (
        await db.execute(
            select(AuthIdentity.id).where(
                AuthIdentity.issuer == f"https://securetoken.google.com/{settings.firebase_project_id}",
                AuthIdentity.subject == consumed.firebase_uid,
                AuthIdentity.unlinked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if still_linked is None:
        logger.warning("auth.native_bootstrap.consume rejected reason=identity_unlinked_at_consume")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Identity no longer linked")

    valid_duration_seconds = 5 * 24 * 60 * 60
    session_cookie = await mint_session_cookie_for_uid(
        consumed.firebase_uid, settings.firebase_project_id, settings.firebase_web_api_key, valid_duration_seconds
    )
    if session_cookie is None:
        logger.warning("auth.native_bootstrap.consume failed reason=mint_failed")
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Session cookie mint failed")

    logger.info("auth.native_bootstrap.consume success")
    return NativeBootstrapConsumeResponse(session_cookie=session_cookie, expires_in=valid_duration_seconds)
