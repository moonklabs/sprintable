"""story #2428 PR③ — list_tasks·list_my_tasks·get_overdue_tasks MCP 배선(3-way 공유
GET /api/v2/tasks). BE 축(X-Total-Count 실 total·status_ne 실배선)은
test_2428_pr3_tasks_pagination_realdb.py가 커버 — 여기는 MCP 도구가 헤더를 정확히
읽어 has_more/limit/cursor를 전달하는지만 mock으로 고정."""
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
async def test_list_tasks_signals_has_more():
    from sprintable_mcp.tools.tasks import ListTasksInput, list_tasks

    items = [{"id": "t1"}]
    with patch("sprintable_mcp.tools.tasks.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=667, next_cursor="0:xyz")))
        out = await list_tasks(ListTasksInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_list_tasks_passes_limit_cursor_through():
    from sprintable_mcp.tools.tasks import ListTasksInput, list_tasks

    with patch("sprintable_mcp.tools.tasks.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_tasks(ListTasksInput(limit=20, cursor="0:abc"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 20
    assert kwargs["params"]["cursor"] == "0:abc"


@pytest.mark.anyio
async def test_list_my_tasks_signals_has_more():
    from sprintable_mcp.tools.tasks import ListMyTasksInput, list_my_tasks

    items = [{"id": "t1"}]
    with patch("sprintable_mcp.tools.tasks.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.member_id = "me"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=12, next_cursor="0:xyz")))
        out = await list_my_tasks(ListMyTasksInput())

    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_get_overdue_tasks_still_sends_status_ne_done_and_signals_has_more():
    from sprintable_mcp.tools.analytics import OverdueMemberInput, get_overdue_tasks

    items = [{"id": "t1"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=4, next_cursor="0:xyz")))
        out = await get_overdue_tasks(OverdueMemberInput())

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["status_ne"] == "done"
    assert len(out) == 2
    assert "0:xyz" in out[1].text


@pytest.mark.anyio
async def test_get_overdue_tasks_no_has_more_when_covered():
    from sprintable_mcp.tools.analytics import OverdueMemberInput, get_overdue_tasks

    items = [{"id": "t1"}, {"id": "t2"}]
    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=2)))
        out = await get_overdue_tasks(OverdueMemberInput())

    assert len(out) == 1
