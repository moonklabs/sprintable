"""story #3176(결제②-C) — `get_current_user()`가 AU paused 체크를 호출하는 조건 pin.

doc `au-limit-enforcement-grounding-3176` §1.4: `AUMeteringMiddleware.dispatch()`는
`call_next()`보다 먼저 실행돼 `request.state.au_actor`가 아직 없는 시점이라, 집행은
이 auth dependency로 옮겼다(원안은 미들웨어 사전체크였으나 타이밍 제약으로 구체화 변경).
이 파일은 그 판별 조건(agent+write+非스트리밍+EE-enabled)만 실 DB 없이 mock으로 고정한다
— check_au_not_paused 자체의 판정 로직은 test_3176_check_au_not_paused_realdb.py가 커버.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Request

from app.dependencies import auth as auth_mod
from app.dependencies.auth import AuthContext, get_current_user


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fake_request(method: str, path: str) -> Request:
    scope = {
        "type": "http", "method": method, "path": path,
        "headers": [], "query_string": b"", "server": ("test", 80),
        "scheme": "http", "client": ("test", 1234),
    }
    return Request(scope)


def _patch_common(monkeypatch, *, is_ee_enabled: bool, org_id: str | None = "11111111-1111-1111-1111-111111111111"):
    auth_ctx = AuthContext(
        user_id="22222222-2222-2222-2222-222222222222", email=None,
        claims={"app_metadata": {"api_key_id": "some-key", "actor_type": "agent"}},
        org_id=org_id,
    )
    monkeypatch.setattr(auth_mod, "_resolve_current_user_auth_context", AsyncMock(return_value=auth_ctx))

    spy = AsyncMock()
    monkeypatch.setattr("ee.plan_limits.check_au_not_paused", spy)

    # is_ee_enabled는 property(license_consent 파생)라 인스턴스 직접 setattr 불가
    # (test_2906_storage_quota_enforcement_realdb.py와 동일 우회 — 파생원본을 패치).
    from app.core.config import settings as _settings
    monkeypatch.setattr(_settings, "license_consent", "agreed" if is_ee_enabled else "declined")

    return spy


@pytest.mark.anyio
async def test_agent_write_ee_enabled_calls_check(monkeypatch):
    spy = _patch_common(monkeypatch, is_ee_enabled=True)
    request = _fake_request("POST", "/api/v2/stories")

    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_awaited_once()


@pytest.mark.anyio
async def test_agent_read_not_called(monkeypatch):
    spy = _patch_common(monkeypatch, is_ee_enabled=True)
    request = _fake_request("GET", "/api/v2/stories")

    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_streaming_path_not_called(monkeypatch):
    spy = _patch_common(monkeypatch, is_ee_enabled=True)
    request = _fake_request("POST", "/api/v2/events/stream")

    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_ee_disabled_not_called(monkeypatch):
    """OSS 빌드(is_ee_enabled=False) — 다른 5종 plan_limits 게이트와 동형으로 집행 자체가
    로드되지 않는다(agents.py::create_org_level_agent 등과 동일 관례)."""
    spy = _patch_common(monkeypatch, is_ee_enabled=False)
    request = _fake_request("POST", "/api/v2/stories")

    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_human_actor_not_called(monkeypatch):
    auth_ctx = AuthContext(
        user_id="22222222-2222-2222-2222-222222222222", email="a@b.com",
        claims={"app_metadata": {}}, org_id="11111111-1111-1111-1111-111111111111",
    )
    monkeypatch.setattr(auth_mod, "_resolve_current_user_auth_context", AsyncMock(return_value=auth_ctx))
    spy = AsyncMock()
    monkeypatch.setattr("ee.plan_limits.check_au_not_paused", spy)
    from app.core.config import settings as _settings
    monkeypatch.setattr(_settings, "license_consent", "agreed")

    request = _fake_request("POST", "/api/v2/stories")
    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_no_org_id_not_called(monkeypatch):
    spy = _patch_common(monkeypatch, is_ee_enabled=True, org_id=None)
    request = _fake_request("POST", "/api/v2/stories")

    await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_402_from_check_propagates(monkeypatch):
    """paused org의 쓰기는 get_current_user 자체가 402를 던져 라우터 핸들러까지 안 감."""
    auth_ctx = AuthContext(
        user_id="22222222-2222-2222-2222-222222222222", email=None,
        claims={"app_metadata": {"api_key_id": "some-key", "actor_type": "agent"}},
        org_id="11111111-1111-1111-1111-111111111111",
    )
    monkeypatch.setattr(auth_mod, "_resolve_current_user_auth_context", AsyncMock(return_value=auth_ctx))
    monkeypatch.setattr(
        "ee.plan_limits.check_au_not_paused",
        AsyncMock(side_effect=HTTPException(status_code=402, detail={"code": "PLAN_LIMIT_EXCEEDED"})),
    )
    from app.core.config import settings as _settings
    monkeypatch.setattr(_settings, "license_consent", "agreed")

    request = _fake_request("POST", "/api/v2/stories")
    with pytest.raises(HTTPException) as exc_info:
        await get_current_user(credentials=None, x_agent_api_key=None, x_mcp_transport=None, request=request)
    assert exc_info.value.status_code == 402
