"""story #2428: stories.py 계열(list_stories/list_backlog) + analytics.py search_stories는
docs.py의 body-{data,meta} 규약과 wire shape가 다르다(X-Total-Count/X-Next-Cursor **헤더**).
BE가 X-Next-Cursor를 결과가 있으면 무조건 싣기 때문에(app/routers/stories.py list_stories —
실제 다음 페이지 유무와 무관) 헤더의 존재 자체가 has_more 신호가 아님을 여기서 고정한다:
_has_more_from_headers는 X-Total-Count > len(items) 로만 판단해야 한다(test_mcp_docs_2191_shape.py와
동형 — has_more=False면 안내 블록 없음, True면 2번째 텍스트 블록으로 안내).
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
async def test_list_stories_no_has_more_when_total_equals_page():
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    items = [{"id": "s1"}, {"id": "s2"}]
    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.org_id = None
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=2, next_cursor="2026-01-01T00:00:00")))
        out = await list_stories(ListStoriesInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 1  # X-Next-Cursor가 존재해도 total<=len(items)면 안내 없음


@pytest.mark.anyio
async def test_list_stories_signals_has_more_when_total_exceeds_page():
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.org_id = None
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=5, next_cursor="2026-01-01T00:00:00")))
        out = await list_stories(ListStoriesInput())

    assert len(out) == 2
    assert "2026-01-01T00:00:00" in out[1].text
    assert "더 있음" in out[1].text


@pytest.mark.anyio
async def test_list_stories_passes_limit_and_cursor_through():
    from sprintable_mcp.tools.stories import ListStoriesInput, list_stories

    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.org_id = None
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_stories(ListStoriesInput(limit=50, cursor="0:abc"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 50
    assert kwargs["params"]["cursor"] == "0:abc"


@pytest.mark.anyio
async def test_list_backlog_no_has_more_when_total_equals_page():
    from sprintable_mcp.tools.stories import ListBacklogInput, list_backlog

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=1)))
        out = await list_backlog(ListBacklogInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 1


@pytest.mark.anyio
async def test_list_backlog_signals_has_more_without_cursor_language():
    """이 분기는 cursor 미지원 — 안내는 next_cursor가 아니라 limit 재호출을 가리켜야 한다."""
    from sprintable_mcp.tools.stories import ListBacklogInput, list_backlog

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        # BE가 이 분기에선 X-Next-Cursor를 아예 안 싣는다(라우터: 이 branch는 total만 세팅).
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=10)))
        out = await list_backlog(ListBacklogInput())

    assert len(out) == 2
    assert "x-next-cursor" not in out[1].text.lower()  # 실제 cursor 값 힌트는 없음(cursor 미지원 언급만)
    assert "limit" in out[1].text
    assert "더 있음" in out[1].text


@pytest.mark.anyio
async def test_list_backlog_passes_limit_through_no_cursor_field():
    from sprintable_mcp.tools.stories import ListBacklogInput, list_backlog

    with patch("sprintable_mcp.tools.stories.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_backlog(ListBacklogInput(limit=25))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 25
    assert "cursor" not in kwargs["params"]


@pytest.mark.anyio
async def test_search_stories_signals_has_more_via_headers():
    from sprintable_mcp.tools.analytics import SearchStoriesInput, search_stories

    items = [{"id": "s1"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=3, next_cursor="0:xyz")))
        out = await search_stories(SearchStoriesInput(query="hello"))

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_search_stories_no_has_more_when_covered():
    from sprintable_mcp.tools.analytics import SearchStoriesInput, search_stories

    items = [{"id": "s1"}, {"id": "s2"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=2)))
        out = await search_stories(SearchStoriesInput(query="hello"))

    assert len(out) == 1
