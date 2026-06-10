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

ACCESS_TOKEN_EXPIRE_MINUTES = 15
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
) -> str:
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
) -> dict[str, Any]:
    access = create_access_token(user_id, email, app_metadata)
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


# ─── OAuth State Token ────────────────────────────────────────────────────────

OAUTH_STATE_EXPIRE_MINUTES = 10


def create_oauth_state_token(provider: str) -> str:
    """10분 만료 OAuth state JWT. CSRF 방지용."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=OAUTH_STATE_EXPIRE_MINUTES)
    payload = {
        "type": "oauth_state",
        "provider": provider,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, _get_secret(), algorithm="HS256")


def decode_oauth_state_token(token: str, expected_provider: str) -> None:
    """OAuth state token 검증. 만료/타입/provider 불일치 시 JWTError."""
    payload = decode_jwt(token)
    if payload.get("type") != "oauth_state":
        raise JWTError("Invalid state token type")
    if payload.get("provider") != expected_provider:
        raise JWTError("Provider mismatch in state token")
