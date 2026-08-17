"""story #2706 AC4 — list_tasks/list_my_tasks/get_overdue_tasks MCP 도구가 이미 보내고 있던
project_id가(sprintable_mcp/tools/tasks.py·analytics.py) 실제로 출력 params에 실리는지 실측
(BE 라우터가 그동안 이 파라미터를 안 받아 조용히 버려지고 있었다 — MCP측 코드 변경은 이
스토리 스코프에 없음, 배선만으로 해소되는지 확認하는 회귀가드)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _headers(total: int) -> dict:
    return {"x-total-count": str(total)}


@pytest.mark.anyio
async def test_list_tasks_sends_project_id():
    from sprintable_mcp.tools.tasks import ListTasksInput, list_tasks

    with patch("sprintable_mcp.tools.tasks.client") as mock_client:
        mock_client.require_project_id = lambda: "proj-123"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_tasks(ListTasksInput())

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["project_id"] == "proj-123"


@pytest.mark.anyio
async def test_list_my_tasks_sends_project_id():
    from sprintable_mcp.tools.tasks import ListMyTasksInput, list_my_tasks

    with patch("sprintable_mcp.tools.tasks.client") as mock_client:
        mock_client.require_project_id = lambda: "proj-123"
        mock_client.member_id = "me"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await list_my_tasks(ListMyTasksInput())

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["project_id"] == "proj-123"


@pytest.mark.anyio
async def test_get_overdue_tasks_sends_project_id():
    from sprintable_mcp.tools.analytics import OverdueMemberInput, get_overdue_tasks

    with patch("sprintable_mcp.tools.analytics.client") as mock_client:
        mock_client.require_project_id = lambda: "proj-123"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await get_overdue_tasks(OverdueMemberInput())

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["project_id"] == "proj-123"
