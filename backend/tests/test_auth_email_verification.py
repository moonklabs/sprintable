"""AUTH-05: Email verification 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.security import (
    JWTError,
    create_email_verification_token,
    decode_email_verification_token,
)


# ─── 토큰 유틸리티 ─────────────────────────────────────────────────────────────

def test_verification_token_roundtrip():
    uid = str(uuid.uuid4())
    token = create_email_verification_token(uid)
    payload = decode_email_verification_token(token)
    assert payload["sub"] == uid
    assert payload["type"] == "email_verification"


def test_verification_token_wrong_type_rejected():
    from app.core.security import _get_secret
    from jose import jwt
    from datetime import datetime, timezone, timedelta
    payload = {"sub": str(uuid.uuid4()), "type": "access", "exp": int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())}
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    with pytest.raises(JWTError):
        decode_email_verification_token(token)


# ─── GET /verify-email ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_verify_email_invalid_token_400():
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/auth/verify-email?token=badtoken")
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_verify_email_already_verified_200():
    """이미 인증된 이메일 → 200 (幂等)."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    uid = str(uuid.uuid4())
    token = create_email_verification_token(uid)

    user_mock = MagicMock()
    user_mock.id = uuid.UUID(uid)
    user_mock.email_verified = True

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = user_mock
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get(f"/api/v2/auth/verify-email?token={token}")
        assert resp.status_code == 200
        assert "already" in resp.json()["data"]["message"]
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anyio_backend():
    return "asyncio"
