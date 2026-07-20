"""SPR-37: 로컬/OSS 셀프호스트의 이메일 인증 마찰 제거 — AUTH_AUTO_VERIFY_EMAIL.

도그푸드 1차 실측(2026-07-19): 로컬 스택에는 메일 발송 인프라(RESEND/SMTP)가 없어 인증
메일이 영영 오지 않는데, org 생성이 email_verified를 요구해 SQL(`UPDATE users SET
email_verified=true`) 없이는 첫 게이트 판정에 도달할 수 없었다. TTHW<5분 목표에 정면 배치.

수리 계약: ``settings.auth_auto_verify_email``(기본 False = 프로덕션 무변경). true면 가입
시 email_verified=True로 생성하고 인증 메일 발송을 생략한다 — org 생성 차단(403)도 자연
해소. 로컬 quickstart(.env.example)에서만 true.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    from app.dependencies.database import get_db

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.flush = AsyncMock()
    added: list = []
    mock_session.add = MagicMock(side_effect=added.append)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), added, app


def _register_body():
    return {
        "email": f"u{uuid.uuid4().hex[:8]}@example.com",
        "password": "TestPass1!",
        "display_name": "Test User",
        "tos_accepted": True,
    }


def _added_user(added):
    from app.models.user import User

    users = [a for a in added if isinstance(a, User)]
    assert users, f"User가 session.add되지 않음: {added}"
    return users[0]


@pytest.mark.anyio
async def test_register_auto_verify_on_creates_verified_user_and_skips_mail():
    """플래그 on: 가입 즉시 email_verified=True, 인증 메일 발송 생략."""
    from app.core.config import settings

    client, added, app = await _client()
    send_spy = MagicMock(return_value=True)
    try:
        with patch.object(settings, "auth_auto_verify_email", True), \
             patch("app.services.email.send_email", send_spy):
            async with client as c:
                resp = await c.post("/api/v2/auth/register", json=_register_body())
        assert resp.status_code in (200, 201), resp.text
        assert _added_user(added).email_verified is True
        send_spy.assert_not_called()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_default_still_requires_verification():
    """기본(off): 기존과 동일 — email_verified=False로 생성(프로덕션 무변경)."""
    from app.core.config import settings

    client, added, app = await _client()
    try:
        with patch.object(settings, "auth_auto_verify_email", False), \
             patch("app.services.email.send_email", MagicMock(return_value=False)):
            async with client as c:
                resp = await c.post("/api/v2/auth/register", json=_register_body())
        assert resp.status_code in (200, 201), resp.text
        assert _added_user(added).email_verified is False
    finally:
        app.dependency_overrides.clear()
