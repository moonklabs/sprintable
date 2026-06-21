"""E-MCP-HTTP S1: Streamable HTTP transport + per-connection bearer auth.

핵심: ①transport 공존(기본 stdio 무회귀·http 선택) ②per-request 키 contextvar→api_client 헤더(멀티테넌트)
③per-key bounded scope 캐시(LRU+TTL) ④bearer auth 미들웨어(401·contextvar set·X-Project-Id·health 통과)
⑤이벤트 채널 분리(http=SSE 미구동·구조적). 전부 CI-runnable(실서버 X·ASGI mock).
"""
from __future__ import annotations


import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ① transport / config ──────────────────────────────────────────────────────
def test_transport_default_stdio():
    from sprintable_mcp.config import McpSettings
    s = McpSettings()
    assert s.mcp_transport == "stdio"            # 기본 stdio = 로컬 무회귀
    assert s.mcp_scope_cache_max_size > 0
    assert s.mcp_scope_cache_ttl_seconds > 0


# ── ② per-request 키 contextvar ───────────────────────────────────────────────
def test_api_key_override_contextvar():
    from sprintable_mcp.api_client import (
        _api_key_override, set_api_key_override, reset_api_key_override,
    )
    assert _api_key_override.get() is None        # 기본 미설정(stdio)
    tok = set_api_key_override("reqkey")
    assert _api_key_override.get() == "reqkey"
    reset_api_key_override(tok)
    assert _api_key_override.get() is None
    tok2 = set_api_key_override("")               # 빈 키 → None(falsy 정규화)
    assert _api_key_override.get() is None
    reset_api_key_override(tok2)


@pytest.mark.anyio
async def test_request_uses_override_key_then_env_fallback():
    """request 헤더 키 = per-request override ∨ env 단일키(무회귀)."""
    from unittest.mock import AsyncMock, patch
    from sprintable_mcp.api_client import SprintableClient, set_api_key_override, reset_api_key_override
    c = SprintableClient()
    c.configure("https://x", "envkey")
    captured = {}

    async def _fake_request(method, url, **kw):
        captured["headers"] = kw.get("headers", {})
        class R:
            status_code = 200
            is_success = True
            headers = {"content-type": "application/json"}
            def json(self): return {}
            @property
            def text(self): return "{}"
        return R()

    with patch("httpx.AsyncClient.request", new=AsyncMock(side_effect=_fake_request)):
        # override 없음 → env 키
        await c.get("/x")
        assert captured["headers"]["Authorization"] == "Bearer envkey"
        # override 설정 → 그 키
        tok = set_api_key_override("reqkey")
        try:
            await c.get("/x")
            assert captured["headers"]["Authorization"] == "Bearer reqkey"
            assert captured["headers"]["x-agent-api-key"] == "reqkey"
        finally:
            reset_api_key_override(tok)


# ── ③ per-key bounded scope 캐시 ──────────────────────────────────────────────
def test_scope_cache_lru_and_ttl():
    from sprintable_mcp.server import _ScopeCache, _SCOPE_MISS
    c = _ScopeCache(max_size=2, ttl_seconds=100)
    assert c.get("k1") is _SCOPE_MISS
    c.put("k1", ["a"])
    c.put("k2", ["b"])
    assert c.get("k1") == ["a"]
    c.put("k3", ["c"])                             # max2 초과 → LRU(k2가 최근접근 아니라면) evict
    # k1을 위에서 get해 touch했으니 k2가 LRU → evict 대상
    assert c.get("k2") is _SCOPE_MISS
    assert c.get("k3") == ["c"]
    # TTL 만료
    c2 = _ScopeCache(max_size=10, ttl_seconds=-1)  # 즉시 만료
    c2.put("z", ["x"])
    assert c2.get("z") is _SCOPE_MISS


@pytest.mark.anyio
async def test_load_scope_for_per_key():
    """키마다 다른 manifest scope 캐시(per-key)."""
    from unittest.mock import AsyncMock, patch
    from sprintable_mcp import server as srv
    srv._scope_cache = srv._ScopeCache(10, 100)  # 격리
    calls = {"n": 0}

    async def _fake_get(path):
        calls["n"] += 1
        return {"scope": ["tool_a"]}

    with patch.object(srv.client, "get", new=AsyncMock(side_effect=_fake_get)):
        s1 = await srv._load_scope_for("keyA")
        s1b = await srv._load_scope_for("keyA")  # 캐시 히트(추가 호출 X)
        assert s1 == ["tool_a"] and s1b == ["tool_a"]
        assert calls["n"] == 1                    # keyA 1회만 fetch(캐시)
        await srv._load_scope_for("keyB")         # 다른 키 → 새 fetch
        assert calls["n"] == 2


# ── ④ bearer auth ASGI 미들웨어 ───────────────────────────────────────────────
async def _run_asgi(mw, path, headers):
    """미들웨어를 mock app으로 구동. 반환 (status, app_called, captured_key)."""
    state = {"app_called": False, "key": "__none__", "project": "__none__", "status": None, "body": b""}
    from sprintable_mcp.api_client import _api_key_override, _project_override

    async def _app(scope, receive, send):
        state["app_called"] = True
        state["key"] = _api_key_override.get()
        state["project"] = _project_override.get()

    async def _recv(): return {"type": "http.request", "body": b"", "more_body": False}
    async def _send(msg):
        if msg["type"] == "http.response.start":
            state["status"] = msg["status"]
        elif msg["type"] == "http.response.body":
            state["body"] += msg.get("body", b"")

    scope = {"type": "http", "path": path,
             "headers": [(k.encode(), v.encode()) for k, v in headers.items()]}
    await mw(_app)(scope, _recv, _send)
    return state


@pytest.mark.anyio
async def test_bearer_middleware_401_without_bearer():
    from sprintable_mcp.http_auth import bearer_auth_asgi
    st = await _run_asgi(bearer_auth_asgi, "/mcp", {})           # bearer 없음
    assert st["status"] == 401 and not st["app_called"]
    st2 = await _run_asgi(bearer_auth_asgi, "/mcp", {"authorization": "Bearer "})  # 빈 키
    assert st2["status"] == 401


@pytest.mark.anyio
async def test_bearer_middleware_sets_contextvar():
    from sprintable_mcp.http_auth import bearer_auth_asgi
    st = await _run_asgi(bearer_auth_asgi, "/mcp",
                         {"authorization": "Bearer sk_abc", "x-project-id": "proj-1"})
    assert st["app_called"] and st["key"] == "sk_abc" and st["project"] == "proj-1"


@pytest.mark.anyio
async def test_bearer_middleware_health_path_passes_without_auth():
    """비-/mcp 경로(health 등)는 인증 없이 통과(S2 Cloud Run 헬스체크 호환)."""
    from sprintable_mcp.http_auth import bearer_auth_asgi
    st = await _run_asgi(bearer_auth_asgi, "/health", {})        # bearer 없어도
    assert st["app_called"] and st["status"] is None            # 401 아님·app 통과


@pytest.mark.anyio
async def test_bearer_middleware_resets_contextvar_after_request():
    """요청 後 contextvar 누수 0(finally reset)."""
    from sprintable_mcp.http_auth import bearer_auth_asgi
    from sprintable_mcp.api_client import _api_key_override
    await _run_asgi(bearer_auth_asgi, "/mcp", {"authorization": "Bearer k1"})
    assert _api_key_override.get() is None                       # 누수 없음
