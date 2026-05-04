from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

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


async def _build_app_metadata(user: User, session: AsyncSession) -> dict:
    from app.models.team import TeamMember

    # 1. user_id로 연결된 team_member 조회
    result = await session.execute(
        select(TeamMember)
        .where(
            TeamMember.user_id == user.id,
            TeamMember.is_active.is_(True),
        )
        .order_by(TeamMember.created_at.asc())
        .limit(1)
    )
    member = result.scalar_one_or_none()
    if member and member.user_id is None:
        member.user_id = user.id

    if not member:
        # 2. user_id 미연결 human team_member 중 첫 번째에 자동 연결
        result2 = await session.execute(
            select(TeamMember)
            .where(
                TeamMember.user_id.is_(None),
                TeamMember.is_active.is_(True),
                TeamMember.type == "human",
            )
            .order_by(TeamMember.created_at.asc())
            .limit(1)
        )
        member = result2.scalar_one_or_none()
        if member:
            member.user_id = user.id

    if not member:
        return {}

    return {
        "org_id": str(member.org_id),
        "project_id": str(member.project_id),
    }


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

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
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

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
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

    tokens = create_tokens(str(user.id), email=user.email, app_metadata=await _build_app_metadata(user, session))
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


# ─── OAuth ────────────────────────────────────────────────────────────────────

_OAUTH_CONFIGS: dict[str, dict] = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v3/userinfo",
        "scope": "openid email profile",
        "id_field": "sub",
        "email_field": "email",
    },
    "github": {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user",
        "scope": "read:user user:email",
        "id_field": "id",
        "email_field": "email",
    },
}


def _redirect_uri(provider: str) -> str:
    return f"{settings.app_url}/api/auth/callback/{provider}"


def _client_id(provider: str) -> str:
    return settings.google_client_id if provider == "google" else settings.github_client_id


def _client_secret(provider: str) -> str:
    return settings.google_client_secret if provider == "google" else settings.github_client_secret


class OAuthCallbackRequest(BaseModel):
    provider: str
    code: str
    state: str


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(provider: str) -> JSONResponse:
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]
    state = secrets.token_urlsafe(32)
    params = {
        "client_id": _client_id(provider),
        "redirect_uri": _redirect_uri(provider),
        "response_type": "code",
        "scope": cfg["scope"],
        "state": state,
    }
    if provider == "google":
        params["access_type"] = "offline"
        params["prompt"] = "select_account"
    url = f"{cfg['authorize_url']}?{urlencode(params)}"
    return _ok({"url": url, "state": state})


@router.post("/oauth/callback")
async def oauth_callback(
    body: OAuthCallbackRequest,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    provider = body.provider
    if provider not in _OAUTH_CONFIGS:
        return _err("INVALID_PROVIDER", f"Unsupported provider: {provider}", 400)
    cfg = _OAUTH_CONFIGS[provider]

    async with httpx.AsyncClient(timeout=15) as client:
        # 1. code → access_token 교환
        token_resp = await client.post(
            cfg["token_url"],
            data={
                "client_id": _client_id(provider),
                "client_secret": _client_secret(provider),
                "code": body.code,
                "redirect_uri": _redirect_uri(provider),
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
        if token_resp.status_code != 200:
            return _err("OAUTH_TOKEN_EXCHANGE_FAILED", "Failed to exchange code for token", 400)
        token_data = token_resp.json()
        access_token = token_data.get("access_token")
        if not access_token:
            return _err("OAUTH_NO_TOKEN", "No access_token in response", 400)

        # 2. userinfo 조회
        userinfo_resp = await client.get(
            cfg["userinfo_url"],
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if userinfo_resp.status_code != 200:
            return _err("OAUTH_USERINFO_FAILED", "Failed to fetch user info", 400)
        userinfo = userinfo_resp.json()

        # GitHub email이 null인 경우 /user/emails로 추가 조회
        if provider == "github" and not userinfo.get("email"):
            emails_resp = await client.get(
                "https://api.github.com/user/emails",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if emails_resp.status_code == 200:
                emails = emails_resp.json()
                primary = next((e["email"] for e in emails if e.get("primary") and e.get("verified")), None)
                if primary:
                    userinfo["email"] = primary

    oauth_id = str(userinfo.get(cfg["id_field"], ""))
    email = (userinfo.get(cfg["email_field"]) or "").lower().strip()

    if not oauth_id or not email:
        return _err("OAUTH_MISSING_INFO", "Missing id or email from provider", 400)

    # 3. 기존 유저 조회 (oauth_id 기준 → email 기준 순)
    id_col = User.google_id if provider == "google" else User.github_id
    result = await session.execute(select(User).where(id_col == oauth_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()

    if not user:
        # 동일 이메일 유저가 있으면 OAuth ID 연결
        result = await session.execute(select(User).where(User.email == email, User.is_active.is_(True)))
        user = result.scalar_one_or_none()
        if user:
            await session.execute(
                update(User).where(User.id == user.id).values(**{f"{provider}_id": oauth_id})
            )
            await session.commit()
            await session.refresh(user)
        else:
            # 신규 유저 생성 (비밀번호 없음 — OAuth 전용)
            user = User(
                email=email,
                hashed_password="",
                is_active=True,
                **{f"{provider}_id": oauth_id},
            )
            session.add(user)
            try:
                await session.commit()
                await session.refresh(user)
            except IntegrityError:
                await session.rollback()
                return _err("EMAIL_CONFLICT", "Email already registered", 409)

    # 4. JWT 발급
    from datetime import timedelta
    from app.core.security import ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS

    tokens = create_tokens(str(user.id), user.email, await _build_app_metadata(user, session))
    raw_refresh = tokens["refresh_token"]
    expires_at = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    await _store_refresh_token(session, user, raw_refresh, expires_at)

    return _ok({
        "access_token": tokens["access_token"],
        "refresh_token": raw_refresh,
        "token_type": "bearer",
        "expires_in": ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    })
