"""E-MCP-OPT(story ff6cb90d) — 까심 QA 지적(conv ac49f871) 반영: "무인자+ambiguous=명시 에러"가
실제로 나가는 지점 실증. `SprintableClient.require_project_id()`가 그 지점이고, 개별 MCP 툴
함수가 이를 호출해 자기 try/except로 잡아 err() TextContent로 노출한다(신규 플러밍 불요 —
기존 에러 표면화 관용구 그대로 재사용)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clear_cache():
    import sprintable_mcp.api_client as ac
    ac._auth_ctx_cache.clear()
    yield
    ac._auth_ctx_cache.clear()


def _fresh_client(api_key="envkey"):
    from sprintable_mcp.api_client import SprintableClient
    c = SprintableClient()
    c.configure("https://be", api_key)
    return c


def test_require_project_id_returns_value_when_resolved():
    """단일/명시 default로 해소된 경우 — 그냥 값 반환(에러 없음)."""
    c = _fresh_client()
    c._project_id = "p1"
    assert c.require_project_id() == "p1"


def test_require_project_id_raises_guided_error_when_ambiguous():
    """무인자+ambiguous(멀티프로젝트+미설정) — SprintableApiError로 가이드 메시지+접근가능 목록."""
    from sprintable_mcp.api_client import SprintableApiError

    c = _fresh_client()
    c._project_id = ""
    c._accessible_project_ids = ["pa", "pb", "pc"]

    with pytest.raises(SprintableApiError) as exc_info:
        c.require_project_id()
    err = exc_info.value
    assert "project_id" in str(err) or "프로젝트" in str(err)
    assert "set_default_project" in str(err)
    assert err.body["accessible_project_ids"] == ["pa", "pb", "pc"]


def test_require_project_id_override_wins_even_when_ambiguous():
    """per-call override(85429ee0)가 있으면 ambiguous 상태여도 에러 없이 그 값 사용(회귀 방지)."""
    from sprintable_mcp.api_client import reset_project_override, set_project_override

    c = _fresh_client()
    c._project_id = ""
    c._accessible_project_ids = ["pa", "pb"]
    tok = set_project_override("explicit-P")
    try:
        assert c.require_project_id() == "explicit-P"
    finally:
        reset_project_override(tok)


@pytest.mark.anyio
async def test_tool_call_surfaces_guided_error_as_text_content():
    """실제 MCP 툴(list_stories) 호출 — ambiguous 상태에서 err() TextContent로 가이드 메시지 노출
    (새 플러밍 없이 기존 try/except가 그대로 잡음 — 까심 QA가 확인하려는 정확한 지점)."""
    from sprintable_mcp.api_client import client
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    client._project_id = ""
    client._accessible_project_ids = ["proj-a", "proj-b"]
    try:
        result = await list_stories(ListStoriesInput())
        assert len(result) == 1
        text = result[0].text
        assert text.startswith("Error:")
        assert "set_default_project" in text
    finally:
        client._project_id = ""
        client._accessible_project_ids = []


@pytest.mark.anyio
async def test_tool_call_succeeds_when_unambiguous():
    """단일/명시 default 상태 — require_project_id()가 정상 값을 반환해 백엔드 호출까지 도달."""
    from sprintable_mcp.api_client import client
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    client._project_id = "proj-a"
    with patch.object(client, "get", new=AsyncMock(return_value=[{"id": "s1"}])):
        try:
            result = await list_stories(ListStoriesInput())
        finally:
            client._project_id = ""
    body = json.loads(result[0].text)
    assert body == [{"id": "s1"}]
