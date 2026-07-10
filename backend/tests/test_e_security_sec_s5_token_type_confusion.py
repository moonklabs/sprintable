"""E-SECURITY SEC-S5(story 278fe427·P0 핫픽스): refresh 토큰 타입혼동 봉인.

까심 라이브 재현: refresh 토큰(JWT payload에 type="refresh")이 get_current_user의 JWT 경로를
그대로 통과해 access 토큰 대신 쓰였다(200 OK) — RefreshToken.revoked_at은 /auth/refresh 전용
경로에서만 조회돼 제거된 멤버의 이미 발급된 refresh 토큰이 그대로 API 접근에 재사용 가능했다.
고정 후: type != "access"는 401.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.core.security import create_access_token, create_refresh_token
from app.dependencies.auth import get_current_user, get_current_user_streaming


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


@pytest.mark.anyio
async def test_access_token_passes_get_current_user():
    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, app_metadata={"org_id": str(uuid.uuid4())})
    ctx = await get_current_user(credentials=_creds(token), x_agent_api_key=None, x_mcp_transport=None, db=AsyncMock())
    assert ctx.user_id == user_id


@pytest.mark.anyio
async def test_refresh_token_rejected_by_get_current_user():
    """까심 재현 시나리오의 정확한 봉인 대상 — refresh 토큰이 Bearer로 더 이상 안 먹힌다."""
    user_id = str(uuid.uuid4())
    token, _exp = create_refresh_token(user_id, app_metadata={"org_id": str(uuid.uuid4())})
    with pytest.raises(HTTPException) as exc_info:
        await get_current_user(credentials=_creds(token), x_agent_api_key=None, x_mcp_transport=None, db=AsyncMock())
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_access_token_passes_get_current_user_streaming():
    user_id = str(uuid.uuid4())
    token = create_access_token(user_id, app_metadata={"org_id": str(uuid.uuid4())})
    ctx = await get_current_user_streaming(credentials=_creds(token), x_agent_api_key=None)
    assert ctx.user_id == user_id


@pytest.mark.anyio
async def test_refresh_token_rejected_by_get_current_user_streaming():
    user_id = str(uuid.uuid4())
    token, _exp = create_refresh_token(user_id, app_metadata={"org_id": str(uuid.uuid4())})
    with pytest.raises(HTTPException) as exc_info:
        await get_current_user_streaming(credentials=_creds(token), x_agent_api_key=None)
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_ws_chat_authenticate_rejects_refresh_token(monkeypatch):
    """ws_chat._authenticate도 동일 봉인 — refresh 토큰이면 None(인증 실패)."""
    from app.routers import ws_chat

    class _FakeSession:
        async def __aenter__(self):
            return AsyncMock()

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(ws_chat, "async_session_factory", lambda: _FakeSession())

    user_id = str(uuid.uuid4())
    refresh, _exp = create_refresh_token(user_id)
    result = await ws_chat._authenticate(api_key=None, token=refresh)
    assert result is None
