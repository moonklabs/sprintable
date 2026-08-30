"""story #3247 — POST /api/v2/auth/totp/disable(신설). 인벤토리(#3246) 발견 A: FE가
`/api/v2/auth/2fa/disable`를 쳤는데 BE에 해제 라우트 자체가 없어(setup/verify만 존재)
2FA를 한 번 켜면 UI로 절대 못 껐다. 이 파일은 해제가 실제로 서버까지 도달하고, AC1(재검증
필수 — 현행 TOTP 코드 또는 비밀번호)이 실제로 강제되는지 pin한다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pyotp
import pytest

USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _make_user(*, totp_enabled: bool, totp_secret: str | None, hashed_password: str) -> MagicMock:
    user = MagicMock()
    user.id = USER_ID
    user.email = "u@example.com"
    user.totp_enabled = totp_enabled
    user.totp_secret = totp_secret
    user.hashed_password = hashed_password
    return user


async def _disable_client():
    """story #3204/#3216 동형 패턴 — override_db_and_read 경유(라우트 실경로 관통,
    라우터 함수 직접호출 아님 — 미들웨어·JSON 파싱까지 포함해 진짜 HTTP 계약 증명)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock())
    mock_session.add = MagicMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(USER_ID)
        return ctx

    override_db_and_read(app, override_db)
    app.dependency_overrides[get_current_user] = override_auth

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_disable_with_correct_totp_code_succeeds_and_clears_secret():
    from app.core.security import hash_password
    from app.models.login_audit_log import LoginAuditLog

    secret = pyotp.random_base32()
    user = _make_user(totp_enabled=True, totp_secret=secret, hashed_password=hash_password("pw"))
    client, session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            code = pyotp.TOTP(secret).now()
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"code": code})
        assert resp.status_code == 200
        assert resp.json()["data"]["totp_enabled"] is False

        audit_calls = [c.args[0] for c in session.add.call_args_list if isinstance(c.args[0], LoginAuditLog)]
        assert len(audit_calls) == 1
        assert audit_calls[0].event_type == "2fa_disabled"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_correct_password_succeeds_when_code_unavailable():
    """AC1 — 인증기 분실 시에도 비밀번호로 해제 가능해야 한다(그게 이 스토리의 존재 이유)."""
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("correct-horse"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "correct-horse"})
        assert resp.status_code == 200
        assert resp.json()["data"]["totp_enabled"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_wrong_totp_code_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"code": "000000"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "INVALID_TOTP"
        assert user.totp_enabled is True  # 상태 무변경(방어 실증)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_with_wrong_password_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("correct"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "wrong"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "WRONG_PASSWORD"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_without_reverification_rejected():
    """양성대조(§AC3) — code·password 둘 다 없으면 400, 무인증 해제는 서버가 거부한다."""
    from app.core.security import hash_password

    user = _make_user(totp_enabled=True, totp_secret=pyotp.random_base32(), hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "REVERIFICATION_REQUIRED"
        assert user.totp_enabled is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_when_not_enabled_rejected():
    from app.core.security import hash_password

    user = _make_user(totp_enabled=False, totp_secret=None, hashed_password=hash_password("pw"))
    client, _session, app = await _disable_client()
    try:
        with patch("app.routers.auth._get_user_by_id", new=AsyncMock(return_value=user)):
            async with client as c:
                resp = await c.post("/api/v2/auth/totp/disable", json={"password": "pw"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "TOTP_NOT_ENABLED"
    finally:
        app.dependency_overrides.clear()
