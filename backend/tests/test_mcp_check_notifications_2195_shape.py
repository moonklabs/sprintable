"""story #2195 후속: GET /api/v2/notifications 응답이 bare array → {data, meta}(#2231 규약 A)로
바뀌었다. sprintable_mcp/tools/notifications.py::check_notifications는 client.get()의 raw
passthrough라 그대로 두면 호출 에이전트가 어느 날 배열 대신 {data,meta} 객체를 받게 된다
(sprintable PyPI 0.1.1 — 외부 uvx 사용자도 영향권). 이 MCP 툴의 계약(1차 블록=에이전트가
보는 배열)은 유지한다 — data만 꺼내 돌려주는 것을 이 테스트로 고정한다.

오르테가군 후속 지적: 배열만 언랩해 돌려주면 "목록이 조용히 끝난 척한다" 병(사람 화면에서
방금 고친 그 병)이 에이전트 표면엔 그대로 남는다. has_more일 때 2차 텍스트 블록으로
다음 페이지 안내(next_cursor)를 덧붙이고, before 파라미터로 실제로 다음 페이지를 받을 수
있는 것까지 이 파일에서 고정한다.
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
        "meta": {"has_more": False, "next_cursor": None},
    }

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.get = AsyncMock(return_value=new_shape_response)
        out = await check_notifications(CheckNotificationsInput())

    # 툴 계약 유지 — 에이전트는 여전히 1차 블록으로 «배열»을 받는다(meta 봉투가 새 값이 아니다).
    parsed = json.loads(out[0].text)
    assert isinstance(parsed, list)
    assert parsed == new_shape_response["data"]
    # has_more=False면 다음 페이지 안내 블록을 안 붙인다(과잉 신호 금지).
    assert len(out) == 1


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
    assert len(out) == 1


@pytest.mark.anyio
async def test_check_notifications_signals_has_more_with_next_page_hint():
    """AC(오르테가군 지적) 핵심 — «더 있다»가 에이전트 표면에서 안 사라진다."""
    from sprintable_mcp.tools.notifications import CheckNotificationsInput, check_notifications

    new_shape_response = {
        "data": [{"id": "n1", "title": "hello", "is_read": False}],
        "meta": {"has_more": True, "next_cursor": "2026-01-01T00:00:00+00:00"},
    }

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.get = AsyncMock(return_value=new_shape_response)
        out = await check_notifications(CheckNotificationsInput())

    # 1차 블록은 여전히 순수 배열(데이터 오염 없음 — 안내가 배열 안에 섞이지 않는다).
    parsed = json.loads(out[0].text)
    assert parsed == new_shape_response["data"]
    # 2차 블록에 다음 페이지 커서가 실제로 실려 있다.
    assert len(out) == 2
    assert "2026-01-01T00:00:00+00:00" in out[1].text
    assert "더 있음" in out[1].text


@pytest.mark.anyio
async def test_check_notifications_passes_before_cursor_through():
    """before 인자를 넘기면 실제로 BE 쿼리파라미터로 전달돼 다음 페이지를 받을 수 있다."""
    from sprintable_mcp.tools.notifications import CheckNotificationsInput, check_notifications

    with patch("sprintable_mcp.tools.notifications.client") as mock_client:
        mock_client.get = AsyncMock(return_value={"data": [], "meta": {"has_more": False, "next_cursor": None}})
        await check_notifications(CheckNotificationsInput(before="2026-01-01T00:00:00+00:00"))

    _, kwargs = mock_client.get.call_args
    assert kwargs["params"]["before"] == "2026-01-01T00:00:00+00:00"
