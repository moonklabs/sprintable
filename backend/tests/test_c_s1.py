"""C-S1: FastAPI 자체 JWT 인증 시스템 — password hashing, JWT, TOTP, refresh/logout"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    from app.dependencies.database import get_db
    app.dependency_overrides[get_db] = override_db
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _make_user(totp_enabled: bool = False, totp_secret: str | None = None) -> MagicMock:
    from app.core.security import hash_password
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "test@example.com"
    u.hashed_password = hash_password("correct-password")
    u.is_active = True
    u.totp_enabled = totp_enabled
    u.totp_secret = totp_secret
    return u


# ─── security.py unit tests ───────────────────────────────────────────────────

def test_password_hash_and_verify():
    from app.core.security import hash_password, verify_password
    hashed = hash_password("mysecret")
    assert hashed != "mysecret"
    assert verify_password("mysecret", hashed)
    assert not verify_password("wrong", hashed)


def test_create_access_token_decode():
    from app.core.security import create_access_token, decode_jwt
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        token = create_access_token("user-123", email="a@b.com", app_metadata={"org_id": "o1"})
        payload = decode_jwt(token)
    assert payload["sub"] == "user-123"
    assert payload["email"] == "a@b.com"
    assert payload["app_metadata"]["org_id"] == "o1"
    assert payload["type"] == "access"


def test_create_refresh_token():
    from app.core.security import create_refresh_token, decode_jwt
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        token, exp = create_refresh_token("user-123")
        payload = decode_jwt(token)
    assert payload["type"] == "refresh"
    assert payload["sub"] == "user-123"
    assert "jti" in payload
    assert isinstance(exp, datetime)


def test_hash_token_deterministic():
    from app.core.security import hash_token
    h1 = hash_token("raw-token")
    h2 = hash_token("raw-token")
    assert h1 == h2
    assert h1 != "raw-token"


def test_totp_generate_verify():
    from app.core.security import generate_totp_secret, verify_totp, get_totp_provisioning_uri
    import pyotp
    secret = generate_totp_secret()
    assert len(secret) >= 16
    code = pyotp.TOTP(secret).now()
    assert verify_totp(secret, code)
    assert not verify_totp(secret, "000000")
    uri = get_totp_provisioning_uri(secret, "user@example.com")
    assert "otpauth://totp" in uri
    assert "Sprintable" in uri


# ─── POST /api/v2/auth/register ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_register_new_user_201():
    client, session, app = await _client()
    try:
        result_none = MagicMock()
        result_none.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=result_none)
        with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
            async with client as c:
                resp = await c.post("/api/v2/auth/register", json={"email": "new@test.com", "password": "pass123"})
        assert resp.status_code == 201
        body = resp.json()
        assert body["error"] is None
        assert "access_token" in body["data"]
        assert "refresh_token" in body["data"]
        assert body["data"]["token_type"] == "bearer"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_duplicate_email_409():
    client, session, app = await _client()
    try:
        result_existing = MagicMock()
        result_existing.scalar_one_or_none.return_value = _make_user()
        session.execute = AsyncMock(return_value=result_existing)
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json={"email": "exists@test.com", "password": "pass"})
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "EMAIL_TAKEN"
    finally:
        app.dependency_overrides.clear()


# ─── POST /api/v2/auth/token ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_login_success_200():
    client, session, app = await _client()
    try:
        user = _make_user()
        result = MagicMock()
        result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=result)
        with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
            async with client as c:
                resp = await c.post("/api/v2/auth/token", json={"email": "test@example.com", "password": "correct-password"})
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert "access_token" in data
        assert "refresh_token" in data
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_login_wrong_password_401():
    client, session, app = await _client()
    try:
        user = _make_user()
        result = MagicMock()
        result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=result)
        async with client as c:
            resp = await c.post("/api/v2/auth/token", json={"email": "test@example.com", "password": "wrong"})
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "INVALID_CREDENTIALS"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_login_totp_required_403():
    client, session, app = await _client()
    try:
        user = _make_user(totp_enabled=True, totp_secret="JBSWY3DPEHPK3PXP")
        result = MagicMock()
        result.scalar_one_or_none.return_value = user
        session.execute = AsyncMock(return_value=result)
        async with client as c:
            resp = await c.post("/api/v2/auth/token", json={"email": "test@example.com", "password": "correct-password"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "TOTP_REQUIRED"
    finally:
        app.dependency_overrides.clear()


# ─── POST /api/v2/auth/refresh ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_refresh_token_rotation_200():
    from app.core.security import create_refresh_token, hash_token
    with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
        raw_refresh, exp = create_refresh_token(str(uuid.uuid4()))

    client, session, app = await _client()
    try:
        user = _make_user()
        stored = MagicMock()
        stored.token_hash = hash_token(raw_refresh)
        stored.expires_at = exp
        stored.revoked_at = None

        def side_effect(stmt):
            r = MagicMock()
            r.scalar_one_or_none.return_value = stored
            return r

        session.execute = AsyncMock(side_effect=side_effect)

        with patch("app.routers.auth._get_user_by_id", new_callable=AsyncMock) as mock_user:
            mock_user.return_value = user
            with patch.dict("os.environ", {"JWT_SECRET": "test-secret"}):
                async with client as c:
                    resp = await c.post("/api/v2/auth/refresh", json={"refresh_token": raw_refresh})
        assert resp.status_code == 200
        body = resp.json()["data"]
        assert "access_token" in body
        assert "refresh_token" in body
        assert body["refresh_token"] != raw_refresh  # rotation
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_refresh_invalid_token_401():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/refresh", json={"refresh_token": "not.a.valid.token"})
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


# ─── POST /api/v2/auth/logout ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_logout_200():
    client, session, app = await _client()
    try:
        session.execute = AsyncMock(return_value=MagicMock())
        async with client as c:
            resp = await c.post("/api/v2/auth/logout", json={"refresh_token": "some.token.here"})
        assert resp.status_code == 200
        assert resp.json()["data"]["ok"] is True
    finally:
        app.dependency_overrides.clear()
