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


def test_transport_env_name_is_MCP_TRANSPORT(monkeypatch):
    """⭐S2 배포 회귀 봉쇄: mcp_transport 는 **env `MCP_TRANSPORT`** 로 읽힌다(env_prefix 없음).
    deploy 가 SPRINTABLE_MCP_TRANSPORT 로 set하면 무시→stdio→placeholder /auth/me 크래시(2026-06-21 사건).
    env-name 매핑을 직접 검증(S1 테스트는 settings 직접 set이라 이 read 경로 미커버였음)."""
    from sprintable_mcp.config import McpSettings
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    monkeypatch.setenv("SPRINTABLE_MCP_TRANSPORT", "stdio")  # 잘못된 이름 → 무시돼야
    assert McpSettings().mcp_transport == "http"             # MCP_TRANSPORT 가 정답
    monkeypatch.delenv("MCP_TRANSPORT")
    assert McpSettings().mcp_transport == "stdio"            # 미설정 → 기본 stdio


def test_deploy_relevant_env_names(monkeypatch):
    """⭐배포 env 이름 계약 고정: API_URL·KEY 는 필드명 일치(SPRINTABLE_API_URL·AGENT_API_KEY)."""
    from sprintable_mcp.config import McpSettings
    monkeypatch.setenv("SPRINTABLE_API_URL", "https://dev-be")
    monkeypatch.setenv("AGENT_API_KEY", "sk_dev")
    s = McpSettings()
    assert s.sprintable_api_url == "https://dev-be"
    assert s.agent_api_key == "sk_dev"


def test_allowed_hosts_env_read_and_protection(monkeypatch):
    """⭐S2 421 fix: 기본 빈 MCP_ALLOWED_HOSTS → DNS-rebinding 보호 OFF(Cloud Run host 허용)·지정 시
    화이트리스트 보호 ON. env-read(MCP_ALLOWED_HOSTS)+protection toggle 검증(monkeypatch.setenv)."""
    from mcp.server.transport_security import TransportSecuritySettings
    from sprintable_mcp.config import McpSettings

    # 기본(미설정) → 빈 문자열 → 보호 OFF
    s0 = McpSettings()
    hosts0 = [h.strip() for h in (s0.mcp_allowed_hosts or "").split(",") if h.strip()]
    ts0 = TransportSecuritySettings(enable_dns_rebinding_protection=bool(hosts0), allowed_hosts=hosts0)
    assert ts0.enable_dns_rebinding_protection is False   # Cloud Run host 421 방지

    # MCP_ALLOWED_HOSTS env → 화이트리스트·보호 ON
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "mcp-dev.sprintable.ai,foo.run.app")
    s1 = McpSettings()
    assert s1.mcp_allowed_hosts == "mcp-dev.sprintable.ai,foo.run.app"   # env-name read
    hosts1 = [h.strip() for h in s1.mcp_allowed_hosts.split(",") if h.strip()]
    # ⭐codex RC: allowed_origins 는 scheme 포함(`https://host`)이어야 브라우저 Origin exact-match(bare
    # host 면 Origin 요청 403). allowed_hosts(bare)와 다른 파생.
    origins1 = [f"https://{h}" for h in hosts1]
    ts1 = TransportSecuritySettings(
        enable_dns_rebinding_protection=bool(hosts1), allowed_hosts=hosts1, allowed_origins=origins1)
    assert ts1.enable_dns_rebinding_protection is True
    assert "mcp-dev.sprintable.ai" in ts1.allowed_hosts          # Host=bare
    assert "https://mcp-dev.sprintable.ai" in ts1.allowed_origins  # Origin=scheme 포함


def test_module_mcp_protection_off_by_default():
    """현 모듈 mcp(빈 hosts 임포트)는 DNS-rebinding 보호 OFF — Cloud Run 호스팅 421 회피."""
    from sprintable_mcp.server import mcp
    assert mcp.settings.transport_security.enable_dns_rebinding_protection is False


def test_allowed_origins_derive_scheme(monkeypatch):
    """⭐codex RC 회귀: MCP_ALLOWED_HOSTS set 시 모듈 mcp 의 allowed_origins 가 `https://{host}`(scheme
    포함)로 파생 — bare host 면 브라우저 Origin 요청 403(prod-precision 갭)."""
    monkeypatch.setenv("MCP_ALLOWED_HOSTS", "mcp-dev.sprintable.ai")
    import importlib
    import sprintable_mcp.server as srv
    importlib.reload(srv)
    try:
        ts = srv.mcp.settings.transport_security
        assert ts.allowed_hosts == ["mcp-dev.sprintable.ai"]
        assert ts.allowed_origins == ["https://mcp-dev.sprintable.ai"]   # scheme 파생
        assert ts.enable_dns_rebinding_protection is True
    finally:
        monkeypatch.delenv("MCP_ALLOWED_HOSTS")
        importlib.reload(srv)  # 모듈 원복(다른 테스트 격리)


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
async def test_bearer_middleware_health_returns_200_without_auth():
    """⭐S2: /health·/healthz → 200 직응답(인증 불요·Cloud Run HTTP liveness·streamable_http_app 404 방지)."""
    from sprintable_mcp.http_auth import bearer_auth_asgi
    for p in ("/health", "/healthz"):
        st = await _run_asgi(bearer_auth_asgi, p, {})            # bearer 없어도
        assert st["status"] == 200 and not st["app_called"]     # 200·app 미통과(미들웨어 직응답)
        assert b"ok" in st["body"]


@pytest.mark.anyio
async def test_bearer_middleware_other_nonmcp_path_passes():
    """비-/mcp·비-health 경로는 인증 없이 app 으로 통과(향후 라우트 호환)."""
    from sprintable_mcp.http_auth import bearer_auth_asgi
    st = await _run_asgi(bearer_auth_asgi, "/other", {})
    assert st["app_called"] and st["status"] is None


@pytest.mark.anyio
async def test_bearer_middleware_resets_contextvar_after_request():
    """요청 後 contextvar 누수 0(finally reset)."""
    from sprintable_mcp.http_auth import bearer_auth_asgi
    from sprintable_mcp.api_client import _api_key_override
    await _run_asgi(bearer_auth_asgi, "/mcp", {"authorization": "Bearer k1"})
    assert _api_key_override.get() is None                       # 누수 없음
