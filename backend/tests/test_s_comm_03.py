"""S-COMM-03: fakechat relay 제거 검증 테스트.

AC1: relay_to_fakechat 함수 제거 — sse_bridge에 존재하지 않음.
AC2: _send_mcp_notification 유지 — 모든 이벤트에 notifications/claude/channel 발송.
AC3: MCP notification은 backfill·webhook 여부 무관하게 항상 발송.
AC4: has_webhook / fakechat_port 설정 제거됨.
FIX: send_log_message → _write_stream.send(JSONRPCNotification) 교체 (오스카군 실검증).
"""
from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock, MagicMock, patch


# ── AC1: relay_to_fakechat 제거 ───────────────────────────────────────────────

def test_relay_to_fakechat_removed():
    """relay_to_fakechat 함수가 sse_bridge 모듈에 존재하지 않아야 함."""
    import sprintable_mcp.sse_bridge as bridge
    assert not hasattr(bridge, "relay_to_fakechat"), (
        "relay_to_fakechat must be removed from sse_bridge (S-COMM-03 AC1)"
    )


def test_relay_event_types_removed():
    """_RELAY_EVENT_TYPES 상수가 sse_bridge 모듈에 존재하지 않아야 함."""
    import sprintable_mcp.sse_bridge as bridge
    assert not hasattr(bridge, "_RELAY_EVENT_TYPES")


def test_build_relay_payload_removed():
    """_build_relay_payload 함수가 sse_bridge 모듈에 존재하지 않아야 함."""
    import sprintable_mcp.sse_bridge as bridge
    assert not hasattr(bridge, "_build_relay_payload")


# ── AC2: _send_mcp_notification 유지 ─────────────────────────────────────────

def test_send_mcp_notification_exists():
    """_send_mcp_notification 함수가 sse_bridge 모듈에 존재해야 함."""
    import sprintable_mcp.sse_bridge as bridge
    assert hasattr(bridge, "_send_mcp_notification")
    assert asyncio.iscoroutinefunction(bridge._send_mcp_notification)


def test_register_session_exists():
    """register_session 함수가 유지되어야 함."""
    import sprintable_mcp.sse_bridge as bridge
    assert hasattr(bridge, "register_session")


# ── AC3: MCP notification은 항상 발송 ────────────────────────────────────────

def test_handle_does_not_call_relay():
    """start_sse_bridge의 _handle 내부에 relay_to_fakechat 호출이 없어야 함."""
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge.start_sse_bridge)
    assert "relay_to_fakechat" not in source, (
        "_handle must not call relay_to_fakechat (S-COMM-03 AC1)"
    )


def test_handle_always_sends_mcp_notification():
    """start_sse_bridge 소스에 _send_mcp_notification 호출이 있어야 함."""
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge.start_sse_bridge)
    assert "_send_mcp_notification" in source


# ── AC4: config에서 fakechat 전용 필드 제거 ──────────────────────────────────

def test_fakechat_port_removed_from_config():
    """McpSettings에 fakechat_port 필드가 없어야 함."""
    from sprintable_mcp.config import McpSettings
    assert not hasattr(McpSettings(), "fakechat_port"), (
        "fakechat_port must be removed from McpSettings (S-COMM-03 AC4)"
    )


def test_has_webhook_removed_from_config():
    """McpSettings에 has_webhook 필드가 없어야 함."""
    from sprintable_mcp.config import McpSettings
    assert not hasattr(McpSettings(), "has_webhook"), (
        "has_webhook must be removed from McpSettings (S-COMM-03 AC4)"
    )


# ── MCP notification 기능 동작 검증 ─────────────────────────────────────────

def test_send_mcp_notification_skips_when_no_session():
    """세션 미등록 시 _send_mcp_notification이 조용히 skip."""
    import sprintable_mcp.sse_bridge as bridge
    bridge._active_session = None
    asyncio.get_event_loop().run_until_complete(
        bridge._send_mcp_notification("memo_created", '{"event_id":"test"}')
    )
    # 에러 없이 완료되면 AC2 pass


def test_send_mcp_notification_uses_write_stream():
    """세션 등록 시 _send_mcp_notification이 _write_stream.send로 channel notification 전송 (FIX)."""
    import sprintable_mcp.sse_bridge as bridge
    from mcp.types import JSONRPCNotification

    mock_write_stream = AsyncMock()
    mock_session = MagicMock()
    mock_session._write_stream = mock_write_stream
    bridge._active_session = mock_session

    try:
        asyncio.get_event_loop().run_until_complete(
            bridge._send_mcp_notification("story_assigned", '{"event_id":"abc","conversation_id":"def"}')
        )
        mock_write_stream.send.assert_called_once()
        sent_arg = mock_write_stream.send.call_args.args[0]
        # JSONRPCMessage 래핑 확인
        notification = sent_arg.message.root
        assert isinstance(notification, JSONRPCNotification)
        assert notification.method == "notifications/claude/channel"
        assert notification.params["meta"]["message_id"] == "abc"
        assert notification.params["meta"]["thread_id"] == "def"
        assert notification.params["content"] == '{"event_id":"abc","conversation_id":"def"}'
    finally:
        bridge._active_session = None


def test_send_mcp_notification_no_send_log_message():
    """_send_mcp_notification이 send_log_message()를 호출하지 않아야 함 (FIX)."""
    import inspect
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge._send_mcp_notification)
    # 호출 패턴(괄호 포함)으로 체크 — docstring 언급과 구분
    assert "send_log_message(" not in source, (
        "_send_mcp_notification must not call send_log_message() (replaced by _write_stream.send)"
    )


def test_send_mcp_notification_uses_channel_method():
    """_send_mcp_notification 소스에 notifications/claude/channel method가 있어야 함 (FIX)."""
    import inspect
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge._send_mcp_notification)
    assert "notifications/claude/channel" in source
