"""S-COMM-03: fakechat relay 복구 + MCP notification 병행 검증 테스트.

AC1: relay_to_fakechat 함수 유지 — notifications/claude/channel은 공인 플러그인 전용.
AC2: _send_mcp_notification 유지 — send_log_message 경로로 MCP 알림 발송.
AC3: MCP notification은 backfill·webhook 여부 무관하게 항상 발송.
AC4: has_webhook / fakechat_port 설정 유지 — relay 조건 판단에 사용.
"""
from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock, MagicMock, patch


# ── AC1: relay_to_fakechat 복구 ───────────────────────────────────────────────

def test_relay_to_fakechat_exists():
    """relay_to_fakechat 함수가 sse_bridge 모듈에 존재해야 함 (AC1 복구)."""
    import sprintable_mcp.sse_bridge as bridge
    assert hasattr(bridge, "relay_to_fakechat"), (
        "relay_to_fakechat must exist in sse_bridge (S-COMM-03 restore)"
    )
    assert asyncio.iscoroutinefunction(bridge.relay_to_fakechat)


def test_relay_event_types_exists():
    """_RELAY_EVENT_TYPES 상수가 sse_bridge 모듈에 존재해야 함 (AC1 복구)."""
    import sprintable_mcp.sse_bridge as bridge
    assert hasattr(bridge, "_RELAY_EVENT_TYPES")
    assert "conversation:message" in bridge._RELAY_EVENT_TYPES


def test_build_relay_payload_exists():
    """_build_relay_payload 함수가 sse_bridge 모듈에 존재해야 함 (AC1 복구)."""
    import sprintable_mcp.sse_bridge as bridge
    assert hasattr(bridge, "_build_relay_payload")


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

def test_handle_calls_relay():
    """start_sse_bridge의 _handle 내부에 relay_to_fakechat 호출이 있어야 함 (AC1 복구)."""
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge.start_sse_bridge)
    assert "relay_to_fakechat" in source, (
        "_handle must call relay_to_fakechat (S-COMM-03 restore)"
    )
    # relay 조건: has_webhook False + backfill 아닐 때
    assert "has_webhook" in source
    assert "is_backfill" in source


def test_handle_always_sends_mcp_notification():
    """start_sse_bridge 소스에 _send_mcp_notification 호출이 있어야 함."""
    import sprintable_mcp.sse_bridge as bridge
    source = inspect.getsource(bridge.start_sse_bridge)
    assert "_send_mcp_notification" in source


# ── AC4: config fakechat 전용 필드 유지 ─────────────────────────────────────

def test_fakechat_port_in_config():
    """McpSettings에 fakechat_port 필드가 있어야 함 (AC4 복구)."""
    from sprintable_mcp.config import McpSettings
    assert hasattr(McpSettings(), "fakechat_port"), (
        "fakechat_port must exist in McpSettings (S-COMM-03 restore)"
    )
    assert McpSettings().fakechat_port == 8787


def test_has_webhook_in_config():
    """McpSettings에 has_webhook 필드가 있어야 함 (AC4 복구)."""
    from sprintable_mcp.config import McpSettings
    assert hasattr(McpSettings(), "has_webhook"), (
        "has_webhook must exist in McpSettings (S-COMM-03 restore)"
    )


# ── MCP notification 기능 동작 검증 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_send_mcp_notification_skips_when_no_session():
    """세션 미등록 시 _send_mcp_notification이 조용히 skip."""
    import sprintable_mcp.sse_bridge as bridge
    bridge._active_session = None
    await bridge._send_mcp_notification("memo_created", '{"event_id":"test"}')
    # 에러 없이 완료되면 AC2 pass


@pytest.mark.anyio
async def test_send_mcp_notification_calls_session():
    """세션 등록 시 _send_mcp_notification이 send_log_message 호출 (원복)."""
    import sprintable_mcp.sse_bridge as bridge

    mock_session = MagicMock()
    mock_session.send_log_message = AsyncMock()
    bridge._active_session = mock_session

    try:
        await bridge._send_mcp_notification("story_assigned", '{"event_id":"abc"}')
        mock_session.send_log_message.assert_called_once()
        call_kwargs = mock_session.send_log_message.call_args.kwargs
        assert call_kwargs["level"] == "info"
        assert call_kwargs["data"]["event_type"] == "story_assigned"
    finally:
        bridge._active_session = None
