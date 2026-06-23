"""E-MCP-HTTP ee2f4e58: HTTP 경로 default project_id 해소(키 컨텍스트·stdio parity).

근본(두 겹): _run_http 가 resolve_auth_context 미호출(싱글톤 _project_id 빈값) + 툴 래퍼
server.py 가 _project_override 를 None arg 로 clobber → client.project_id="" → 백엔드 422.
fix: 미들웨어가 요청경계서 키별 ensure_auth_context 해소·캐시, 프로퍼티 폴백체인을
override → stdio self._* → http per-key 해소 로. 명시 project_id(override)는 최우선(Poke 무회귀).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clear_cache():
    """per-key 캐시는 모듈 전역 → 테스트 간 격리(누수 0)."""
    import sprintable_mcp.api_client as ac
    ac._auth_ctx_cache.clear()
    yield
    ac._auth_ctx_cache.clear()


def _fresh_client(api_url="https://be", api_key="envkey"):
    from sprintable_mcp.api_client import SprintableClient
    c = SprintableClient()
    c.configure(api_url, api_key)
    return c


@pytest.mark.anyio
async def test_ensure_auth_context_resolves_and_caches_per_key():
    """키별 /auth/me 1회 해소·캐시(같은 키 재호출은 캐시 히트·다른 키는 새 fetch). 빈 키는 no-op."""
    c = _fresh_client()
    calls = {"n": 0}

    async def _fake_get(path, **kw):
        calls["n"] += 1
        return {"member_id": "m1", "org_id": "o1", "project_id": "p1"}

    with patch.object(c, "get", new=AsyncMock(side_effect=_fake_get)):
        ctx = await c.ensure_auth_context("keyA")
        assert ctx == {"member_id": "m1", "org_id": "o1", "project_id": "p1"}
        await c.ensure_auth_context("keyA")            # 캐시 히트(추가 fetch X)
        assert calls["n"] == 1
        await c.ensure_auth_context("keyB")            # 다른 키 → 새 fetch
        assert calls["n"] == 2
        assert await c.ensure_auth_context("") == {}   # 빈 키 → no-op
        assert calls["n"] == 2


@pytest.mark.anyio
async def test_http_default_resolved_when_no_explicit_project():
    """http: override=None(arg 부재)·self._* 빈값 → per-key 해소 default 사용(422 제거 핵심)."""
    from sprintable_mcp.api_client import set_api_key_override, reset_api_key_override
    c = _fresh_client(api_key="_http_per_request_bearer_only_")  # http placeholder
    c._project_id = c._org_id = c._member_id = ""                # http 싱글톤 미해소 상태

    async def _fake_get(path, **kw):
        return {"member_id": "mh", "org_id": "oh", "project_id": "ph"}

    with patch.object(c, "get", new=AsyncMock(side_effect=_fake_get)):
        ktok = set_api_key_override("reqkeyA")
        try:
            await c.ensure_auth_context("reqkeyA")
            assert c.project_id == "ph"     # 폴백 → 해소 default
            assert c.org_id == "oh"
            assert c.member_id == "mh"
        finally:
            reset_api_key_override(ktok)


@pytest.mark.anyio
async def test_explicit_project_override_wins_poke_no_regression():
    """명시 project_id → override 최우선(외부/Poke 호출자 무회귀). 해소 default 는 무시된다."""
    from sprintable_mcp.api_client import (
        reset_api_key_override,
        reset_project_override,
        set_api_key_override,
        set_project_override,
    )
    c = _fresh_client(api_key="_http_per_request_bearer_only_")
    c._project_id = ""

    async def _fake_get(path, **kw):
        return {"member_id": "mh", "org_id": "oh", "project_id": "ph"}

    with patch.object(c, "get", new=AsyncMock(side_effect=_fake_get)):
        ktok = set_api_key_override("reqkeyA")
        await c.ensure_auth_context("reqkeyA")
        ptok = set_project_override("explicit-P")   # 툴 arg 로 들어온 명시 project
        try:
            assert c.project_id == "explicit-P"     # override 최우선(해소 ph 무시)
        finally:
            reset_project_override(ptok)
            reset_api_key_override(ktok)


def test_stdio_no_regression_uses_singleton_attr():
    """stdio: self._*(startup resolve) 우선·캐시 미사용 → 무회귀."""
    c = _fresh_client(api_key="envkey")
    c._project_id, c._org_id, c._member_id = "stdio-P", "stdio-O", "stdio-M"
    assert c.project_id == "stdio-P"   # 캐시 비어도 싱글톤 값
    assert c.org_id == "stdio-O"
    assert c.member_id == "stdio-M"


@pytest.mark.anyio
async def test_override_none_falls_through_not_explicit_empty():
    """override=None(미설정)은 falsy → skip 하고 다음 단계로 fall-through(오르테가 ①)."""
    from sprintable_mcp.api_client import (
        reset_api_key_override,
        set_api_key_override,
    )
    c = _fresh_client(api_key="_http_per_request_bearer_only_")
    c._project_id = ""

    async def _fake_get(path, **kw):
        return {"member_id": "", "org_id": "", "project_id": "ph"}

    with patch.object(c, "get", new=AsyncMock(side_effect=_fake_get)):
        ktok = set_api_key_override("reqkeyA")
        try:
            await c.ensure_auth_context("reqkeyA")
            # _project_override 미설정(None) → skip → self._project_id("") skip → 해소 "ph"
            assert c.project_id == "ph"
        finally:
            reset_api_key_override(ktok)


@pytest.mark.anyio
async def test_middleware_triggers_ensure_auth_context():
    """미들웨어가 요청경계서 ensure_auth_context(요청 키) 호출(no-arg 툴 default 해소 트리거)."""
    from sprintable_mcp import api_client as ac
    from sprintable_mcp.http_auth import bearer_auth_asgi
    seen: dict = {}

    async def _fake_ensure(key):
        seen["key"] = key
        return {}

    async def _app(scope, receive, send):
        seen["app"] = True

    async def _recv():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def _send(msg):
        pass

    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=_fake_ensure)):
        scope = {"type": "http", "path": "/mcp",
                 "headers": [(b"authorization", b"Bearer sk_req")]}
        await bearer_auth_asgi(_app)(scope, _recv, _send)
    assert seen.get("key") == "sk_req" and seen.get("app") is True


@pytest.mark.anyio
async def test_middleware_ensure_failure_non_fatal():
    """ensure_auth_context 실패해도 app 통과(auth additive·non-fatal)."""
    from sprintable_mcp import api_client as ac
    from sprintable_mcp.http_auth import bearer_auth_asgi
    state = {"app": False}

    async def _boom(key):
        raise RuntimeError("auth/me down")

    async def _app(scope, receive, send):
        state["app"] = True

    async def _recv():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def _send(msg):
        pass

    with patch.object(ac.client, "ensure_auth_context", new=AsyncMock(side_effect=_boom)):
        scope = {"type": "http", "path": "/mcp",
                 "headers": [(b"authorization", b"Bearer sk_x")]}
        await bearer_auth_asgi(_app)(scope, _recv, _send)
    assert state["app"] is True   # 해소 실패해도 인증 흐름 진행
