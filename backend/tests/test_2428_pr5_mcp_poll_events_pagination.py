"""story #2428 PR⑤ — poll_events MCP 도구 배선 mock 테스트. BE 축(X-Total-Count 실 total)은
test_2428_pr5_poll_events_pagination_realdb.py가 커버 — 여기는 MCP 도구가 헤더를 정확히
읽어 has_more/limit/cursor를 전달하고, 이 도구 특유의 «다시 불러도 안 비워짐» 안내 문구를
내는지만 mock으로 고정."""
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
async def test_poll_events_signals_has_more_with_consume_aware_hint():
    from sprintable_mcp.tools.agent_runs import PollEventsInput, poll_events

    items = [{"id": "e1"}, {"id": "e2"}]
    with patch("sprintable_mcp.tools.agent_runs.client") as mock_client:
        mock_client.member_id = "me"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=5, next_cursor="0:xyz")))
        out = await poll_events(PollEventsInput())

    parsed = json.loads(out[0].text)
    assert parsed == items
    assert len(out) == 2
    assert "0:xyz" in out[1].text
    # consume형 특유 안내 — cursor 없이 다시 불러도 안 비워진다는 것을 명시.
    assert "비워지지 않" in out[1].text


@pytest.mark.anyio
async def test_poll_events_no_has_more_when_covered():
    from sprintable_mcp.tools.agent_runs import PollEventsInput, poll_events

    items = [{"id": "e1"}]
    with patch("sprintable_mcp.tools.agent_runs.client") as mock_client:
        mock_client.member_id = "me"
        mock_client.get_with_headers = AsyncMock(return_value=(items, _headers(total=1)))
        out = await poll_events(PollEventsInput())

    assert len(out) == 1


@pytest.mark.anyio
async def test_poll_events_passes_limit_cursor_through():
    from sprintable_mcp.tools.agent_runs import PollEventsInput, poll_events

    with patch("sprintable_mcp.tools.agent_runs.client") as mock_client:
        mock_client.member_id = "me"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await poll_events(PollEventsInput(limit=5, cursor="2026-08-17T00:00:00+00:00"))

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["limit"] == 5
    assert kwargs["params"]["cursor"] == "2026-08-17T00:00:00+00:00"


@pytest.mark.anyio
async def test_poll_events_defaults_recipient_to_own_member_id():
    from sprintable_mcp.tools.agent_runs import PollEventsInput, poll_events

    with patch("sprintable_mcp.tools.agent_runs.client") as mock_client:
        mock_client.member_id = "my-member-id"
        mock_client.get_with_headers = AsyncMock(return_value=([], _headers(total=0)))
        await poll_events(PollEventsInput())

    _, kwargs = mock_client.get_with_headers.call_args
    assert kwargs["params"]["recipient_id"] == "my-member-id"
