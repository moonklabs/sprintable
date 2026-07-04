"""E-MCP-OPT S1 (bec3a480): 호스팅(http) MCP tools/list 요청별 scope 필터.

문제: http 모드는 멀티테넌트(多키 동시서비스)인데 tools/list 가 항상 전체 ~95개 도구를 반환
(call-time enforcement는 이미 키별로 정확하지만 list 는 그대로) — 컨텍스트 낭비.

해법: `SprintableFastMCP(FastMCP)` 서브클래스가 `list_tools()`를 오버라이드해 call-time과 동일
primitive(`_api_key_override`·`_load_scope_for`·`is_tool_allowed`)로 http 모드에서만 응답을
필터링한다. **왜 서브클래스인가**: FastMCP.__init__ → _setup_handlers() 가
`self._mcp_server.list_tools()(self.list_tools)`로 **구성 시점 bound method**를 저수준
프로토콜 핸들러에 등록 — 구성 後 인스턴스 몽키패치는 이미 캡처된 참조라 안 먹지만, 서브클래스
오버라이드는 __init__ 이전에 존재해 `self.list_tools` 속성조회(MRO)가 오버라이드로 해소되므로
정확히 먹는다(PO crux 확認: mcp/server/fastmcp/server.py:304 소스 직접 대조).

3개 검증축(PO crux 명시):
①unit — 핸들러 자체(전체 필터 로직) 직접 호출, 키별 scope 상이 시 결과 상이
②ASGI 2-bearer 통합(실경로 핵심) — 실제 streamable_http_app()+bearer_auth_asgi() 스택을
  진짜 MCP client(streamablehttp_client+ClientSession)로 initialize+tools/list 왕복
③stdio 회귀 — 부팅 필터(filter_tools_by_scope)·도구 수·manifest 미조회 무영향
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _isolated_scope_cache():
    """모든 테스트가 격리된 scope 캐시로 시작(다른 테스트 파일의 캐시 오염 방지)."""
    import sprintable_mcp.server as srv
    srv._scope_cache = srv._ScopeCache(10, 100)
    yield


# ── ① unit: SprintableFastMCP.list_tools() 핵심 로직 ──────────────────────────
@pytest.mark.anyio
async def test_list_tools_filters_by_scope_in_http_mode(monkeypatch):
    from sprintable_mcp import server as srv

    monkeypatch.setattr(srv.settings, "mcp_transport", "http")

    async def _fake_get(path):
        return {"scope": ["stories"]}

    with patch.object(srv.client, "get", new=AsyncMock(side_effect=_fake_get)):
        tools = await srv.mcp.list_tools()
        names = {t.name for t in tools}
        assert "sprintable_add_story" in names       # stories 허용 → 노출
        assert "sprintable_send_chat_message" not in names  # chat 미허용 → 숨김
        assert "ping" in names                          # 항상-노출 도구는 유지


@pytest.mark.anyio
async def test_list_tools_differs_per_key_scope(monkeypatch):
    """다른 키 = 다른 scope = 다른 tools/list 결과 (call-time enforcement와 동일 키잉)."""
    from sprintable_mcp import server as srv
    from sprintable_mcp.api_client import reset_api_key_override, set_api_key_override

    monkeypatch.setattr(srv.settings, "mcp_transport", "http")

    async def _fake_get(path):
        from sprintable_mcp.api_client import _api_key_override
        key = _api_key_override.get()
        return {"scope": ["stories"]} if key == "keyA" else {"scope": ["chat"]}

    with patch.object(srv.client, "get", new=AsyncMock(side_effect=_fake_get)):
        tok_a = set_api_key_override("keyA")
        try:
            names_a = {t.name for t in await srv.mcp.list_tools()}
        finally:
            reset_api_key_override(tok_a)

        tok_b = set_api_key_override("keyB")
        try:
            names_b = {t.name for t in await srv.mcp.list_tools()}
        finally:
            reset_api_key_override(tok_b)

    assert "sprintable_add_story" in names_a and "sprintable_send_chat_message" not in names_a
    assert "sprintable_send_chat_message" in names_b and "sprintable_add_story" not in names_b


@pytest.mark.anyio
async def test_list_tools_fail_open_on_manifest_error(monkeypatch):
    """manifest 조회 실패 = fail-open(레거시 비파괴셋) — call-time(_load_scope_for)과 동일 철학.
    백엔드가 최종 SSOT라 list 는 더 보여줘도(noisy) call 은 여전히 403 차단되므로 안전."""
    from sprintable_mcp import server as srv

    monkeypatch.setattr(srv.settings, "mcp_transport", "http")

    async def _boom(path):
        raise RuntimeError("manifest unavailable")

    with patch.object(srv.client, "get", new=AsyncMock(side_effect=_boom)):
        names = {t.name for t in await srv.mcp.list_tools()}
        assert "sprintable_add_story" in names        # 비파괴 → 노출(fail-open)
        assert "sprintable_delete_story" not in names  # destructive → 여전히 숨김(레거시 비파괴셋)


@pytest.mark.anyio
async def test_list_tools_skips_scope_load_when_not_http(monkeypatch):
    """mcp_transport != 'http'(기본 stdio)면 filter 로직 자체를 스킵 — manifest 재조회 0회."""
    from sprintable_mcp import server as srv

    monkeypatch.setattr(srv.settings, "mcp_transport", "stdio")
    calls = {"n": 0}

    async def _fake_get(path):
        calls["n"] += 1
        return {"scope": []}

    with patch.object(srv.client, "get", new=AsyncMock(side_effect=_fake_get)):
        tools = await srv.mcp.list_tools()
        assert calls["n"] == 0                          # manifest 미조회
        assert {t.name for t in tools} == {n for n, *_ in srv._TOOL_DEFS} | {"ping"}


# ── ② ASGI 2-bearer 통합(실경로 핵심) ─────────────────────────────────────────
@pytest.mark.anyio
async def test_http_transport_tools_list_real_path_differs_per_bearer(monkeypatch):
    """실제 streamable_http_app()+bearer_auth_asgi() 스택을 진짜 MCP client(initialize+
    tools/list JSON-RPC 왕복)로 구동 — PO 지정 '실경로 핵심' 검증. 서로 다른 bearer 토큰이
    서로 다른 tools/list 응답을 받는지 세션-레벨에서 확인(핸들러 직접호출이 아닌 전체 스택)."""
    from mcp.client.session import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    from sprintable_mcp import server as srv
    from sprintable_mcp.http_auth import bearer_auth_asgi

    monkeypatch.setattr(srv.settings, "mcp_transport", "http")

    async def _fake_get(path):
        from sprintable_mcp.api_client import _api_key_override
        key = _api_key_override.get()
        return {"scope": ["stories"]} if key == "keyA" else {"scope": ["chat"]}

    app = bearer_auth_asgi(srv.mcp.streamable_http_app())

    def _factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers=headers,
            timeout=timeout or 30,
        )

    results: dict[str, set[str]] = {}
    async with srv.mcp.session_manager.run():
        with patch.object(srv.client, "get", new=AsyncMock(side_effect=_fake_get)):
            for key in ("keyA", "keyB"):
                async with streamablehttp_client(
                    url="http://testserver/mcp",
                    headers={"Authorization": f"Bearer {key}"},
                    httpx_client_factory=_factory,
                ) as (read, write, _get_session_id):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.list_tools()
                        results[key] = {t.name for t in result.tools}

    assert "sprintable_add_story" in results["keyA"]
    assert "sprintable_send_chat_message" not in results["keyA"]
    assert "sprintable_send_chat_message" in results["keyB"]
    assert "sprintable_add_story" not in results["keyB"]
    assert results["keyA"] != results["keyB"]


# ── ③ stdio 회귀 ───────────────────────────────────────────────────────────
def test_stdio_boot_filter_behavior_unchanged(monkeypatch):
    """S3 부팅 필터(filter_tools_by_scope) 로직·제거 대상은 이 변경으로 전혀 안 건드림."""
    from sprintable_mcp import server as srv

    removed: list[str] = []
    monkeypatch.setattr(srv.mcp, "remove_tool", lambda name: removed.append(name))
    n = srv.filter_tools_by_scope(["stories"])
    assert n == len(removed) > 0
    assert "sprintable_add_task" in removed
    assert "sprintable_add_story" not in removed
    assert "sprintable_ping" not in removed


@pytest.mark.anyio
async def test_stdio_list_tools_reflects_real_boot_removal(monkeypatch):
    """stdio 는 list_tools() 필터 로직 자체가 skip(③ 위 유닛 테스트로 이미 확認)이므로, 부팅 시
    filter_tools_by_scope 가 레지스트리에서 실제로 제거한 도구는 list_tools() 에도 그대로
    반영된다(추가 축소도 유령노출도 없음) — 실 레지스트리에 1개 도구를 등록/제거해 최소 재현."""
    from sprintable_mcp import server as srv

    monkeypatch.setattr(srv.settings, "mcp_transport", "stdio")
    before = {t.name for t in await srv.mcp.list_tools()}
    assert "sprintable_add_task" in before

    srv.mcp.remove_tool("sprintable_add_task")   # 실제 레지스트리 mutate(S3 부팅 필터와 동일 API)
    try:
        after = {t.name for t in await srv.mcp.list_tools()}
        assert "sprintable_add_task" not in after
        assert before - after == {"sprintable_add_task"}
    finally:
        # 다른 테스트 파일에 영향 없도록 재등록(원래 등록 코드와 동일한 경로로 복구)
        name, doc, input_cls, fn = next(d for d in srv._TOOL_DEFS if d[0] == "sprintable_add_task")
        srv.mcp.tool()(srv._flat(name, doc, input_cls, fn))
