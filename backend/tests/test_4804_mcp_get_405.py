"""story 4804 - the hosted MCP server answers GET /mcp with 405 (it is stateless and has nothing to send on a stream).

Measured (2026-10-29, product owner): the one thing that keeps `sprintable-mcp-prod` busy all day is a client's `GET /mcp` held open: 888 requests over 30 s = 0.442 concurrent, all from one client; the short requests
are 0.002. In the stateless mode of the SDK a GET gets its own transport, which sends the client nothing but a ping every 15 s, and keeps the connection until the client leaves. The MCP spec lets a server that offers no
stream at the endpoint answer 405, and the TypeScript SDK treats it as «an expected case that should not trigger an error». Here: the answer, that nothing else changes (POST, health, other paths, the key rules),
that the switch gives the SDK's behaviour back, and that the real SDK app is what is wrapped.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _call(mw, method: str, path: str, headers: dict[str, str]):
    state = {"status": None, "headers": {}, "body": b"", "app_called": False}

    async def _app(scope, receive, send):
        state["app_called"] = True

    async def _recv():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def _send(msg):
        if msg["type"] == "http.response.start":
            state["status"] = msg["status"]
            state["headers"] = {k.decode(): v.decode() for k, v in msg["headers"]}
        elif msg["type"] == "http.response.body":
            state["body"] += msg.get("body", b"")

    scope = {"type": "http", "method": method, "path": path, "headers": [(k.encode(), v.encode()) for k, v in headers.items()]}
    with patch("sprintable_mcp.http_auth.client.ensure_auth_context", new=AsyncMock()) as lookup:
        await mw(_app)(scope, _recv, _send)
    state["lookup_called"] = lookup.called
    return state


def test_the_setting_is_off_by_default_and_read_from_the_env_name_MCP_HTTP_GET_STREAM(monkeypatch):
    from sprintable_mcp.config import McpSettings
    assert McpSettings().mcp_http_get_stream is False
    monkeypatch.setenv("MCP_HTTP_GET_STREAM", "true")
    assert McpSettings().mcp_http_get_stream is True
    monkeypatch.setenv("SPRINTABLE_MCP_HTTP_GET_STREAM", "false")   # a wrong name is ignored, as for the others
    assert McpSettings().mcp_http_get_stream is True


@pytest.mark.anyio
async def test_get_mcp_is_405_with_allow_post_before_the_key_and_before_the_backend_lookup():
    from sprintable_mcp.http_auth import bearer_auth_asgi
    for headers in ({"authorization": "Bearer sk_abc", "accept": "text/event-stream"}, {"accept": "text/event-stream"}, {}):
        st = await _call(bearer_auth_asgi, "GET", "/mcp", headers)
        assert st["status"] == 405 and st["headers"]["allow"] == "POST" and not st["app_called"], headers
        assert not st["lookup_called"], "no call to the backend for a request that is refused"
        assert b"method_not_allowed" in st["body"] and b"sk_abc" not in st["body"]
    st = await _call(bearer_auth_asgi, "GET", "/mcp/", {"authorization": "Bearer sk_abc"})
    assert st["status"] == 405, "the sub-paths of the endpoint too (the middleware's own test of the MCP path)"


@pytest.mark.anyio
async def test_nothing_else_changes_post_health_other_paths_and_the_key_rules():
    from sprintable_mcp.http_auth import bearer_auth_asgi
    st = await _call(bearer_auth_asgi, "POST", "/mcp", {"authorization": "Bearer sk_abc"})
    assert st["app_called"] and st["status"] is None, "a POST reaches the SDK"
    st = await _call(bearer_auth_asgi, "POST", "/mcp", {})
    assert st["status"] == 401 and not st["app_called"], "a POST without a key is still a 401"
    st = await _call(bearer_auth_asgi, "DELETE", "/mcp", {"authorization": "Bearer sk_abc"})
    assert st["app_called"], "a DELETE is the SDK's (it answers 405 itself in this mode)"
    for path in ("/health", "/healthz"):
        st = await _call(bearer_auth_asgi, "GET", path, {})
        assert st["status"] == 200 and b"ok" in st["body"], "the health check is a GET and must keep answering 200"
    st = await _call(bearer_auth_asgi, "GET", "/other", {})
    assert st["app_called"] and st["status"] is None, "a GET outside the MCP path is not ours to refuse"


@pytest.mark.anyio
async def test_the_switch_gives_the_sdks_behaviour_back():
    from sprintable_mcp.http_auth import bearer_auth_asgi
    keep = lambda app: bearer_auth_asgi(app, get_stream=True)   # noqa: E731
    st = await _call(keep, "GET", "/mcp", {"authorization": "Bearer sk_abc"})
    assert st["app_called"] and st["status"] is None, "with the stream on, a GET with a key reaches the SDK as before"
    st = await _call(keep, "GET", "/mcp", {})
    assert st["status"] == 401, "and one without a key is a 401 as before (not a 405)"


def test_the_entry_point_reads_the_setting_and_hands_it_to_the_middleware(monkeypatch):
    """_run_http builds the app itself: drive the app it would serve (uvicorn.run is replaced by a capture)"""
    import asyncio

    import uvicorn

    from sprintable_mcp import __main__ as entry
    from sprintable_mcp.config import settings

    captured = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: captured.update(app=app, **kw))

    async def drive(app, method, headers):
        out = {"status": None}

        async def recv():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(msg):
            if msg["type"] == "http.response.start":
                out["status"] = msg["status"]
        scope = {"type": "http", "method": method, "path": "/mcp", "headers": [(k.encode(), v.encode()) for k, v in headers.items()]}
        with patch("sprintable_mcp.http_auth.client.ensure_auth_context", new=AsyncMock()):
            await asyncio.wait_for(app(scope, recv, send), 5)
        return out["status"]

    monkeypatch.setattr(settings, "mcp_http_get_stream", False)
    entry._run_http()
    assert asyncio.run(drive(captured["app"], "GET", {"authorization": "Bearer k"})) == 405
    monkeypatch.setattr(settings, "mcp_http_get_stream", True)
    entry._run_http()
    assert asyncio.run(drive(captured["app"], "GET", {})) == 401, "switched on: a GET without a key gets the key rule, not the 405"


def test_the_real_sdk_app_behind_the_middleware_answers_a_get_at_once_and_a_post_as_before():
    """the whole thing, not a mock: the SDK's stateless app, in-process. Before this change a GET here never came back (a stream held open)."""
    from starlette.testclient import TestClient

    from sprintable_mcp.http_auth import bearer_auth_asgi
    from sprintable_mcp.server import MAX_MCP_REQUEST_BODY_SIZE, mcp, transport_security

    app = bearer_auth_asgi(mcp.streamable_http_app(stateless_http=True, transport_security=transport_security, max_request_body_size=MAX_MCP_REQUEST_BODY_SIZE))
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}
    with patch("sprintable_mcp.http_auth.client.ensure_auth_context", new=AsyncMock()), TestClient(app) as c:
        r = c.get("/mcp", headers={"Authorization": "Bearer sk_t", "Accept": "text/event-stream"})
        assert r.status_code == 405 and r.headers["allow"] == "POST"
        r = c.post("/mcp", headers={"Authorization": "Bearer sk_t", "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}, json=init)
        assert r.status_code == 200 and "sprintable-mcp-python" in r.text, r.text[:200]
        r = c.post("/mcp", headers={"Authorization": "Bearer sk_t", "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert r.status_code == 200 and '"tools"' in r.text
