"""E-MCP-HTTP prod 승격: 온보딩 mcp_config 의 dev(localhost SSE) ↔ prod(streamable-http) 분기.

env MCP_PUBLIC_URL 설정 시 prod 게이트웨이 http config(per-request Bearer)·미설정 시 dev localhost SSE.
env-driven 이라 monkeypatch.setenv 로 read 경로까지 검증(직접 set 은 미커버).
"""
from app.routers.agents import _build_mcp_config


def test_dev_localhost_sse_when_no_public_url(monkeypatch):
    monkeypatch.delenv("MCP_PUBLIC_URL", raising=False)
    cfg = _build_mcp_config(9123, "sk_live_x")
    srv = cfg["mcpServers"]["sprintable"]
    assert srv["type"] == "sse"
    assert srv["url"] == "http://localhost:9123/sse"
    assert "headers" not in srv  # 로컬 SSE 는 Authorization 헤더 없음.


def test_prod_streamable_http_with_bearer(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://sprintable-mcp-prod-x.run.app/mcp")
    cfg = _build_mcp_config(9123, "sk_live_secret")
    srv = cfg["mcpServers"]["sprintable"]
    assert srv["type"] == "http"
    assert srv["url"] == "https://sprintable-mcp-prod-x.run.app/mcp"  # 게이트웨이 /mcp(localhost 아님).
    assert srv["headers"] == {"Authorization": "Bearer sk_live_secret"}  # per-request bearer.


def test_prod_http_no_key_omits_auth_header(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://sprintable-mcp-prod-x.run.app/mcp")
    cfg = _build_mcp_config(9123, None)
    srv = cfg["mcpServers"]["sprintable"]
    assert srv["type"] == "http" and "headers" not in srv  # 키 없으면 헤더 생략.


def test_blank_public_url_falls_back_to_sse(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "   ")  # 공백 = 미설정 취급.
    cfg = _build_mcp_config(9123, "sk_live_x")
    assert cfg["mcpServers"]["sprintable"]["type"] == "sse"
