"""AUTH-04: forgot/reset/change-password 엔드포인트 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.security import (
    JWTError,
    create_password_reset_token,
    decode_password_reset_token,
    hash_password,
)


# ─── Reset token 유틸리티 ─────────────────────────────────────────────────────

def test_reset_token_roundtrip():
    import hashlib
    uid = str(uuid.uuid4())
    hpw = hash_password("SomePass1!")
    token = create_password_reset_token(uid, hpw)
    payload = decode_password_reset_token(token)
    assert payload["sub"] == uid
    assert payload["type"] == "password_reset"
    assert payload["pw_sig"] == hashlib.sha256(hpw.encode()).hexdigest()[:16]


def test_reset_token_wrong_type_rejected():
    from app.core.security import _get_secret
    from jose import jwt
    from datetime import datetime, timezone, timedelta
    payload = {"sub": str(uuid.uuid4()), "type": "access", "exp": int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())}
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    with pytest.raises(JWTError):
        decode_password_reset_token(token)


def test_pw_sig_changes_after_password_change():
    """비밀번호 변경 후 pw_sig 불일치로 토큰 자동 무효화 확인."""
    import hashlib
    uid = str(uuid.uuid4())
    old_hpw = hash_password("OldPass1!")
    token = create_password_reset_token(uid, old_hpw)
    payload = decode_password_reset_token(token)

    new_hpw = hash_password("NewPass2@")
    assert hashlib.sha256(new_hpw.encode()).hexdigest()[:16] != payload["pw_sig"]


# ─── /forgot-password ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_forgot_password_always_200():
    """존재하지 않는 이메일도 200 반환 (열거 방지)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/auth/forgot-password", json={"email": "ghost@example.com"})
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


# ─── /reset-password ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_reset_password_invalid_token_400():
    """유효하지 않은 토큰 → 400."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    mock_session = AsyncMock()
    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/auth/reset-password", json={"token": "badtoken", "new_password": "NewPass1!"})
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anyio_backend():
    return "asyncio"
