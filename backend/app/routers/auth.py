from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import (
    create_tokens,
    decode_jwt,
    generate_totp_secret,
    get_totp_provisioning_uri,
    hash_password,
    hash_token,
    verify_password,
    verify_totp,
    JWTError,
    REFRESH_TOKEN_EXPIRE_DAYS,
    create_refresh_token,
)
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import RefreshToken, User

from datetime import timedelta

router = APIRouter(prefix="/api/v2/auth", tags=["auth"])


def _ok(data: object, status_code: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status_code)


def _err(code: str, message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        {"data": None, "error": {"code": code, "message": message}, "meta": None},
        status_code=status_code,
    )


# ─── Schemas ──────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str
    totp_code: str | None = None


class RegisterRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class TotpVerifyRequest(BaseModel):
    code: str


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
    return result.scalar_one_or_none()


async def _get_user_by_id(session: AsyncSession, user_id: uuid.UUID) -> User | None:
    result = await session.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    return result.scalar_one_or_none()


def _build_app_metadata(user: User) -> dict:
    return {}


async def _store_refresh_token(
    session: AsyncSession,
    user: User,
    raw_token: str,
    expires_at: datetime,
) -> None:
    row = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw_token),
        org_id=None,
        project_id=None,
        expires_at=expires_at,
    )
    session.add(row)
    await session.commit()


# ─── POST /api/v2/auth/register ───────────────────────────────────────────────

@router.post("/register", status_code=201)
async def register(
    body: RegisterRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    existing = await _get_user_by_email(session, body.email)
    if existing:
        return _err("EMAIL_TAKEN", "Email already registered", 409)

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        is_active=True,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return _err("EMAIL_TAKEN", "Email already registered", 409)

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_build_app_metadata(user))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    return _ok(tokens, 201)


# ─── POST /api/v2/auth/token ──────────────────────────────────────────────────

@router.post("/token")
async def login(
    body: LoginRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    user = await _get_user_by_email(session, body.email)
    if not user or not verify_password(body.password, user.hashed_password):
        return _err("INVALID_CREDENTIALS", "Invalid email or password", 401)

    if user.totp_enabled:
        if not body.totp_code:
            return _err("TOTP_REQUIRED", "TOTP code required", 403)
        if not verify_totp(user.totp_secret or "", body.totp_code):
            return _err("INVALID_TOTP", "Invalid TOTP code", 403)

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_build_app_metadata(user))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    return _ok(tokens)


# ─── POST /api/v2/auth/refresh ────────────────────────────────────────────────

@router.post("/refresh")
async def refresh_token(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    try:
        payload = decode_jwt(body.refresh_token)
    except JWTError:
        return _err("INVALID_TOKEN", "Invalid refresh token", 401)

    if payload.get("type") != "refresh":
        return _err("INVALID_TOKEN", "Not a refresh token", 401)

    token_hash = hash_token(body.refresh_token)
    result = await session.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        return _err("TOKEN_REVOKED", "Refresh token revoked or expired", 401)

    user_id = uuid.UUID(payload["sub"])
    user = await _get_user_by_id(session, user_id)
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 401)

    # 기존 토큰 무효화 (rotation)
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == token_hash)
        .values(revoked_at=datetime.now(timezone.utc))
    )

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_build_app_metadata(user))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp)

    return _ok(tokens)


# ─── POST /api/v2/auth/logout ────────────────────────────────────────────────

@router.post("/logout")
async def logout(
    body: LogoutRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    token_hash = hash_token(body.refresh_token)
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == token_hash, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    await session.commit()
    return _ok({"ok": True})


# ─── POST /api/v2/auth/totp/setup ────────────────────────────────────────────

@router.post("/totp/setup")
async def totp_setup(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 404)
    if user.totp_enabled:
        return _err("TOTP_ALREADY_ENABLED", "TOTP already enabled", 409)

    secret = generate_totp_secret()
    await session.execute(
        update(User).where(User.id == user.id).values(totp_secret=secret)
    )
    await session.commit()

    uri = get_totp_provisioning_uri(secret, user.email)
    return _ok({"totp_secret": secret, "provisioning_uri": uri})


# ─── POST /api/v2/auth/totp/verify ───────────────────────────────────────────

@router.post("/totp/verify")
async def totp_verify(
    body: TotpVerifyRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await _get_user_by_id(session, uuid.UUID(auth.user_id))
    if not user:
        return _err("USER_NOT_FOUND", "User not found", 404)
    if not user.totp_secret:
        return _err("TOTP_NOT_SETUP", "TOTP not initialized", 400)

    if not verify_totp(user.totp_secret, body.code):
        return _err("INVALID_TOTP", "Invalid TOTP code", 403)

    await session.execute(
        update(User).where(User.id == user.id).values(totp_enabled=True)
    )
    await session.commit()
    return _ok({"totp_enabled": True})
