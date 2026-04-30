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
    secret = getattr(settings, "jwt_secret", None) or settings.supabase_jwt_secret or os.environ.get("JWT_SECRET", "")
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


def get_totp_provisioning_uri(secret: str, email: str, issuer: str = "Sprintable") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)
