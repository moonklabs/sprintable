"""AUTH-09: OAuth state 검증 + 로그인 lockout 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.security import (
    JWTError,
    create_oauth_state_token,
    decode_oauth_state_token,
)


# ─── OAuth state token ────────────────────────────────────────────────────────

def test_oauth_state_roundtrip():
    token = create_oauth_state_token("google")
    decode_oauth_state_token(token, "google")  # 예외 없으면 PASS


def test_oauth_state_provider_mismatch_rejected():
    token = create_oauth_state_token("google")
    with pytest.raises(JWTError):
        decode_oauth_state_token(token, "github")


def test_oauth_state_wrong_type_rejected():
    from app.core.security import _get_secret
    from jose import jwt
    from datetime import datetime, timezone, timedelta
    payload = {"type": "access", "provider": "google", "exp": int((datetime.now(timezone.utc) + timedelta(minutes=10)).timestamp())}
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    with pytest.raises(JWTError):
        decode_oauth_state_token(token, "google")


# ─── Login lockout ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_login_locked_account_429():
    """잠긴 계정 로그인 시도 → 429."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient
    from datetime import datetime, timezone, timedelta

    mock_user = MagicMock()
    mock_user.id = uuid.uuid4()
    mock_user.email = "locked@example.com"
    mock_user.hashed_password = "hash"
    mock_user.is_active = True
    mock_user.login_fail_count = 5
    mock_user.login_locked_until = datetime.now(timezone.utc) + timedelta(minutes=4)
    mock_user.totp_enabled = False

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_user
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/auth/token", json={
                "email": "locked@example.com",
                "password": "wrong",
            })
        assert resp.status_code == 429
        assert resp.json()["error"]["code"] == "ACCOUNT_LOCKED"
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anyio_backend():
    return "asyncio"
