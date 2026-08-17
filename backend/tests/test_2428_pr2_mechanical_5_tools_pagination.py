"""story #2428 PR#2 — ① 즉시 가능(BE 이미 준비됨) 5개: list_goals(+alias list_epics 동일 함수)·
get_blocked_stories·get_unassigned_stories·search_docs.

전부 기존 BE 인프라 재사용(신규 BE 변경 0):
- list_goals: app/routers/goals.py list_goals가 이미 limit/cursor/X-Total-Count/X-Next-Cursor 보유.
- get_blocked_stories/get_unassigned_stories: story #2428 PR#1이 이미 고친 GET /api/v2/stories
  (X-Total-Count/X-Next-Cursor 헤더 규약) 재사용 — stories.py의 _has_more_from_headers 그대로.
- search_docs: BE search_full_text 분기가 이미 limit(min(limit,50) 상한)을 받는다. cursor는
  설계상 없음(관련도순 정렬) — has_more 안내 대신 "상한 걸쳤을 수 있음" 문구로 대체.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _headers(total: int, next_cursor: str | None = None) -> dict:
    h = {"x-total-count": str(total)}
    if next_cursor is not None:
        h["x-next-cursor"] = next_cursor
    return h


@pytest.mark.anyio
async def test_list_goals_signals_has_more_via_headers():
    from sprintable_mcp.tools.goals import ListGoalsInput, list_goals

    items = [{"id": "g1"}]
    with patch("sprintable_mcp.tools.goals.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=5, next_cursor="2026-01-01T00:00:00")))
        out = await list_goals(ListGoalsInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "2026-01-01T00:00:00" in out[1].text


@pytest.mark.anyio
async def test_list_goals_no_has_more_when_covered():
    from sprintable_mcp.tools.goals import ListGoalsInput, list_goals

    items = [{"id": "g1"}, {"id": "g2"}]
    with patch("sprintable_mcp.tools.goals.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=2)))
        out = await list_goals(ListGoalsInput())

    assert len(out) == 1


@pytest.mark.anyio
async def test_list_goals_passes_limit_and_cursor_through():
    from sprintable_mcp.tools.goals import ListGoalsInput, list_goals

    with patch("sprintable_mcp.tools.goals.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_goals(ListGoalsInput(limit=25, cursor="0:abc"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 25
    assert kwargs["params"]["cursor"] == "0:abc"


@pytest.mark.anyio
async def test_get_blocked_stories_signals_has_more():
    from sprintable_mcp.tools.analytics import SprintFilterInput, get_blocked_stories

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=9, next_cursor="0:xyz")))
        out = await get_blocked_stories(SprintFilterInput())

    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_get_unassigned_stories_signals_has_more():
    from sprintable_mcp.tools.analytics import SprintFilterInput, get_unassigned_stories

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=9, next_cursor="0:xyz")))
        out = await get_unassigned_stories(SprintFilterInput())

    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_get_blocked_stories_passes_limit_and_status_filter():
    from sprintable_mcp.tools.analytics import SprintFilterInput, get_blocked_stories

    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await get_blocked_stories(SprintFilterInput(limit=10))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 10
    assert kwargs["params"]["status"] == "in-review"


@pytest.mark.anyio
async def test_search_docs_no_cap_warning_when_under_limit():
    from sprintable_mcp.tools.docs import SearchDocsInput, search_docs

    new_shape = {"data": [{"id": "d1"}], "meta": {"has_more": False, "next_cursor": None}}
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value=new_shape)
        out = await search_docs(SearchDocsInput(query="hello", limit=50))

    parsed = json.loads(out[0].text)
    assert parsed == new_shape["data"]
    assert len(out) == 1  # 1건 << limit=50이니 상한 경고 없음


@pytest.mark.anyio
async def test_search_docs_warns_when_result_hits_cap():
    from sprintable_mcp.tools.docs import SearchDocsInput, search_docs

    items = [{"id": f"d{i}"} for i in range(5)]
    new_shape = {"data": items, "meta": {"has_more": False, "next_cursor": None}}
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value=new_shape)
        out = await search_docs(SearchDocsInput(query="hello", limit=5))

    assert len(out) == 2
    assert "상한" in out[1].text
    assert "cursor" in out[1].text


@pytest.mark.anyio
async def test_search_docs_passes_limit_through():
    from sprintable_mcp.tools.docs import SearchDocsInput, search_docs

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value={"data": [], "meta": {"has_more": False, "next_cursor": None}})
        await search_docs(SearchDocsInput(query="hello", limit=30))

    _, kwargs = mock_client.get.call_args
    assert kwargs["params"]["limit"] == 30
