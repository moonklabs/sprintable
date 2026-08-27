from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import pyotp
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

__all__ = [
    "decode_jwt", "JWTError",
    "create_access_token", "create_refresh_token", "create_tokens",
    "create_password_reset_token", "decode_password_reset_token",
    "create_email_verification_token", "decode_email_verification_token",
    "hash_password", "verify_password",
    "generate_totp_secret", "verify_totp", "get_totp_provisioning_uri",
    "hash_token",
    "ACCESS_TOKEN_EXPIRE_MINUTES", "REFRESH_TOKEN_EXPIRE_DAYS",
]

# af8d3641 AC2: 15→60분 완화. 15분은 동시요청 refresh 빈도를 높여 rotation 레이스(→강제 로그아웃)를
# 잦게 함(체감 "세션 너무 짧음"). 60분은 보안 통상 범위(access 15~60분 표준)·refresh 30일이 longevity 담당
# (만료 시 silent refresh). 근본 동시성 fix는 FE single-flight(AC1·별 작업). dev/prod 공유 상수.
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30

_pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")


# ─── Password ─────────────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_context.verify(plain, hashed)


# ─── JWT ──────────────────────────────────────────────────────────────────────

def _get_secret() -> str:
    # fc7bce47: Supabase 잔재 제거 — supabase_jwt_secret 폴백 삭제(jwt_secret 단일).
    # dev/prod 둘 다 JWT_SECRET 세팅 확인됨(PO gcloud 실측) → 기존 토큰 동일 secret 검증·로그아웃 0.
    secret = getattr(settings, "jwt_secret", None) or os.environ.get("JWT_SECRET", "")
    if not secret:
        raise JWTError("JWT_SECRET not configured")
    return secret


def create_access_token(
    user_id: str,
    email: str | None = None,
    app_metadata: dict[str, Any] | None = None,
    expires_delta: timedelta | None = None,
    *,
    auth_source: str | None = None,
    device_attested: bool | None = None,
) -> str:
    """story 1931(산티아고 §10 재확認 2026-07-16 조건4): `auth_source`/`device_attested`는
    옵션 클레임 — None(기본, 기존 모든 호출부: password/oauth_callback/refresh 등)이면
    payload에 아예 안 실려 기존 토큰 shape byte-identical(무회귀). OAuth-handoff consume만
    명시적으로 채워 넣어 "이 세션이 attestation-gated 능력을 상속하지 않는다"는 assurance
    seam을 지금 확보한다(§10.5 — 소비하는 라우트는 아직 없음, 향후 attestation 확장 대비)."""
    now = datetime.now(timezone.utc)
    exp = now + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload: dict[str, Any] = {
        "sub": user_id,
        "email": email,
        "app_metadata": app_metadata or {},
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "type": "access",
    }
    if auth_source is not None:
        payload["auth_source"] = auth_source
    if device_attested is not None:
        payload["device_attested"] = device_attested
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def create_refresh_token(
    user_id: str,
    app_metadata: dict[str, Any] | None = None,
    expires_delta: timedelta | None = None,
) -> tuple[str, datetime]:
    now = datetime.now(timezone.utc)
    exp = now + (expires_delta or timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    payload: dict[str, Any] = {
        "sub": user_id,
        "app_metadata": app_metadata or {},
        "jti": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "type": "refresh",
    }
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    return token, exp


def create_tokens(
    user_id: str,
    email: str | None = None,
    app_metadata: dict[str, Any] | None = None,
    *,
    auth_source: str | None = None,
    device_attested: bool | None = None,
) -> dict[str, Any]:
    access = create_access_token(
        user_id, email, app_metadata, auth_source=auth_source, device_attested=device_attested,
    )
    refresh, expires_at = create_refresh_token(user_id, app_metadata)
    return {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        "refresh_expires_at": expires_at.isoformat(),
    }


def decode_jwt(token: str) -> dict:
    """Decode self-issued JWT (HS256). GoTrue 호환 동일 secret 사용."""
    return jwt.decode(
        token,
        _get_secret(),
        algorithms=["HS256"],
        options={"verify_aud": False},
    )


def decode_jwt_ignore_exp(token: str) -> dict:
    """서명 검증·exp 무시 decode — 만료 토큰서도 sub/claims 추출(계정 메타 resolve 전용).

    우리 서명(JWT_SECRET)만 통과하므로 임의 토큰 정보 leak 0. 부작용 없음(read-only).
    """
    return jwt.decode(
        token,
        _get_secret(),
        algorithms=["HS256"],
        options={"verify_aud": False, "verify_exp": False},
    )


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ─── TOTP ─────────────────────────────────────────────────────────────────────

def generate_totp_secret() -> str:
    return pyotp.random_base32()


def verify_totp(secret: str, code: str) -> bool:
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def verify_totp_with_timestep(secret: str, code: str) -> int | None:
    """TOTP 코드 검증 후 성공한 timestep 반환 (replay 방지용). 실패 시 None."""
    import time as _time
    totp = pyotp.TOTP(secret)
    now = int(_time.time())
    for delta in range(-1, 2):  # valid_window=1 (30초 전/후 허용)
        ts = now // 30 + delta
        if totp.at(ts * 30) == code:
            return ts
    return None


def get_totp_provisioning_uri(secret: str, email: str, issuer: str = "Sprintable") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)


# ─── Password Reset Token ──────────────────────────────────────────────────────

RESET_TOKEN_EXPIRE_MINUTES = 30


def create_password_reset_token(user_id: str, hashed_password: str) -> str:
    """30분 만료 reset token. pw_sig 포함으로 비밀번호 변경 후 자동 무효화."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=RESET_TOKEN_EXPIRE_MINUTES)
    pw_sig = hashlib.sha256(hashed_password.encode()).hexdigest()[:16]
    payload = {
        "sub": user_id,
        "type": "password_reset",
        "pw_sig": pw_sig,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def decode_password_reset_token(token: str) -> dict:
    """Reset token 검증. 만료/타입 불일치 시 JWTError."""
    payload = decode_jwt(token)
    if payload.get("type") != "password_reset":
        raise JWTError("Invalid token type")
    return payload


# ─── Email Verification Token ─────────────────────────────────────────────────

EMAIL_VERIFICATION_EXPIRE_HOURS = 24


def create_email_verification_token(user_id: str) -> str:
    """24시간 만료 이메일 인증 토큰."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(hours=EMAIL_VERIFICATION_EXPIRE_HOURS)
    payload = {
        "sub": user_id,
        "type": "email_verification",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def decode_email_verification_token(token: str) -> dict:
    """Email verification token 검증. 만료/타입 불일치 시 JWTError."""
    payload = decode_jwt(token)
    if payload.get("type") != "email_verification":
        raise JWTError("Invalid token type")
    return payload


# ─── Email Unsubscribe Token ──────────────────────────────────────────────────
# story #3159(retention·최소층) — 리마인드 메일 1-클릭 해제 링크. 반복 발송이 아니라 1회성
# 안내라 만료를 짧게 둘 이유가 없다(수신자가 메일을 나중에 열어도 링크가 죽어있으면 안 됨) —
# email_verification(24h)과 달리 EMAIL_UNSUBSCRIBE_EXPIRE_DAYS=365로 사실상 영구.

EMAIL_UNSUBSCRIBE_EXPIRE_DAYS = 365


def create_email_unsubscribe_token(user_id: str) -> str:
    """1-클릭 수신거부 토큰(사실상 영구 — 위 근거)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=EMAIL_UNSUBSCRIBE_EXPIRE_DAYS)
    payload = {
        "sub": user_id,
        "type": "email_unsubscribe",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def decode_email_unsubscribe_token(token: str) -> dict:
    """Unsubscribe token 검증. 만료/타입 불일치 시 JWTError."""
    payload = decode_jwt(token)
    if payload.get("type") != "email_unsubscribe":
        raise JWTError("Invalid token type")
    return payload


# ─── OAuth State Token ────────────────────────────────────────────────────────

OAUTH_STATE_EXPIRE_MINUTES = 10


def create_oauth_state_token(provider: str, *, link_user_id: str | None = None) -> str:
    """10분 만료 OAuth state JWT. CSRF 방지용.

    story #3122(계정 연결) — link_user_id가 있으면 이 state는 "로그인"이 아니라 "이미
    로그인된 이 유저에게 provider를 연결"하는 요청이라는 신원을 자체 서명으로 실어 나른다.
    self-signed HS256이라 왕복 중 위조 불가 — 콜백에서 이 값과 그 시점의 실제 로그인
    유저를 대조하면(auth.py oauth_link_callback) 10분 창 안에 브라우저 탭에서 계정을
    전환해도 엉뚱한 계정에 연결되는 걸 막는다."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=OAUTH_STATE_EXPIRE_MINUTES)
    payload = {
        "type": "oauth_state",
        "provider": provider,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    if link_user_id is not None:
        payload["link_user_id"] = link_user_id
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def decode_oauth_state_token(token: str, expected_provider: str) -> dict:
    """OAuth state token 검증. 만료/타입/provider 불일치 시 JWTError.

    story #3122 — link_user_id를 호출부가 읽을 수 있도록 payload 전체를 반환하도록 확장
    (기존 반환값 None은 호출부가 어차피 안 쓰고 있었다 — 무회귀)."""
    payload = decode_jwt(token)
    if payload.get("type") != "oauth_state":
        raise JWTError("Invalid state token type")
    if payload.get("provider") != expected_provider:
        raise JWTError("Provider mismatch in state token")
    return payload


# story #3118(Sign in with Apple) — Google과 달리 Apple의 OAuth client_secret은 고정
# 문자열이 아니라 Team ID(iss)·Services ID(sub)·Key ID(kid)+개인키(SIWA Key .p8)로 매 요청
# 서명하는 ES256 JWT다(Apple 공식 요건). Apple은 최대 6개월 만료까지 허용하지만 이 값은
# 매 토큰교환 호출 시점에 그때그때 새로 만들어 쓰므로(caching 안 함 — 트래픽이 실시간 로그인
# 뿐이라 매회 생성 비용이 무시 가능) 짧게(5분) 잡아 노출창을 최소화한다.
APPLE_CLIENT_SECRET_EXPIRE_MINUTES = 5


def apple_client_secret_jwt(team_id: str, services_id: str, key_id: str, private_key_pem: str) -> str:
    """Sign in with Apple client_secret — ES256 서명 JWT(Apple 공식 스펙, 고정 시크릿 아님)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=APPLE_CLIENT_SECRET_EXPIRE_MINUTES)
    payload = {
        "iss": team_id,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "aud": "https://appleid.apple.com",
        "sub": services_id,
    }
    return jwt.encode(payload, private_key_pem, algorithm="ES256", headers={"kid": key_id})
