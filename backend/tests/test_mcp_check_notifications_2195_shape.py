"""story #2195 후속: GET /api/v2/notifications 응답이 bare array → {data, meta}(#2231 규약 A)로
바뀌었다. sprintable_mcp/tools/notifications.py::check_notifications는 client.get()의 raw
passthrough라 그대로 두면 호출 에이전트가 어느 날 배열 대신 {data,meta} 객체를 받게 된다
(sprintable PyPI 0.1.1 — 외부 uvx 사용자도 영향권). 이 MCP 툴의 계약(에이전트가 보는 모양=
배열)은 유지한다 — data만 꺼내 돌려주는 것을 이 테스트로 고정한다.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_check_notifications_unwraps_new_data_meta_shape():
    from sprintable_mcp.tools.notifications import CheckNotificationsInput, check_notifications

    new_shape_response = {
        "data": [{"id": "n1", "title": "hello", "is_read": False}],
        "meta": {"has_more": True, "next_cursor": "2026-01-01T00:00:00+00:00"},
    }

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.get = AsyncMock(return_value=new_shape_response)
        out = await check_notifications(CheckNotificationsInput())

    parsed = json.loads(out[0].text)
    # 툴 계약 유지 — 에이전트는 여전히 «배열»을 받는다(meta 봉투가 새 값이 아니다).
    assert isinstance(parsed, list)
    assert parsed == new_shape_response["data"]


@pytest.mark.anyio
async def test_check_notifications_tolerates_bare_array_response():
    """구 BE(아직 안 갱신됐거나 롤백된 경우) — bare array 그대로 오면 그대로 통과시킨다."""
    from sprintable_mcp.tools.notifications import CheckNotificationsInput, check_notifications

    old_shape_response = [{"id": "n1", "title": "hello", "is_read": False}]

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.get = AsyncMock(return_value=old_shape_response)
        out = await check_notifications(CheckNotificationsInput())

    parsed = json.loads(out[0].text)
    assert parsed == old_shape_response
