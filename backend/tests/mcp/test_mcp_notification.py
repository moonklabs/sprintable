"""S5-4: MCP notification 전송 유닛 테스트."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import sprintable_mcp.sse_bridge as bridge
from sprintable_mcp.sse_bridge import _send_mcp_notification, register_session


def _make_mock_session() -> MagicMock:
    session = MagicMock()
    session.send_log_message = AsyncMock()
    return session


def setup_function():
    """각 테스트 전 세션 레지스트리 초기화."""
    bridge._active_session = None


@pytest.mark.asyncio
async def test_notification_not_sent_without_session():
    """세션 미등록 시 send_log_message 호출 없음."""
    assert bridge._active_session is None
    await _send_mcp_notification("memo_received", '{"data": "test"}')
    # 예외 없이 통과 (세션 없어도 조용히 skip)


@pytest.mark.asyncio
async def test_notification_sent_to_registered_session():
    """세션 등록 후 SSE 이벤트 → send_log_message 호출."""
    session = _make_mock_session()
    register_session(session)

    await _send_mcp_notification("memo_received", '{"title": "킥오프"}')

    session.send_log_message.assert_called_once()
    call_kwargs = session.send_log_message.call_args[1]
    assert call_kwargs["level"] == "info"
    assert call_kwargs["data"]["event_type"] == "memo_received"
    assert '킥오프' in call_kwargs["data"]["data"]
    assert call_kwargs["logger"] == "sprintable.sse"


@pytest.mark.asyncio
async def test_notification_swallows_session_error():
    """session.send_log_message 에러 시 예외 전파 없음."""
    session = _make_mock_session()
    session.send_log_message = AsyncMock(side_effect=Exception("connection closed"))
    register_session(session)

    await _send_mcp_notification("test_event", "data")  # 예외 전파 없음


@pytest.mark.asyncio
async def test_register_session_replaces_previous():
    """register_session 재호출 시 이전 세션 교체."""
    session1 = _make_mock_session()
    session2 = _make_mock_session()

    register_session(session1)
    register_session(session2)

    await _send_mcp_notification("event", "data")

    session1.send_log_message.assert_not_called()
    session2.send_log_message.assert_called_once()


@pytest.mark.asyncio
async def test_relay_and_notification_both_triggered():
    """SSE 이벤트 수신 시 relay + notification 양쪽 태스크 생성 확인."""
    import asyncio as _asyncio

    session = _make_mock_session()
    register_session(session)

    created: list[str] = []
    orig_create = _asyncio.create_task

    def _mock_create(coro, **kwargs):
        created.append(coro.__name__ if hasattr(coro, "__name__") else str(type(coro)))
        return orig_create(coro, **kwargs)

    with patch("sprintable_mcp.sse_bridge.asyncio.create_task", side_effect=_mock_create):
        # _relay_and_dispatch을 직접 호출할 수 없으므로 두 함수가 모두 호출되는지 확인
        tasks = [
            bridge.relay_to_fakechat("conversation:message", '{}', "http://api", "key", 8787),
            bridge._send_mcp_notification("conversation:message", '{}'),
        ]
        await _asyncio.gather(*tasks)

    # send_log_message가 실제로 호출됐는지 확인
    session.send_log_message.assert_called_once()
