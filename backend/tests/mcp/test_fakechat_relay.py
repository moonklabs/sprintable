"""S5-3: fakechat relay 유닛 테스트."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.sse_bridge import _build_relay_payload, relay_to_fakechat


# ── _build_relay_payload ───────────────────────────────────────────────────────

def test_build_relay_payload_non_dict():
    """non-dict data → [event_type] data 텍스트."""
    text, thread_id, is_conv = _build_relay_payload("test", "plain string")
    assert text == "[test] plain string"
    assert thread_id == ""
    assert is_conv is False


def test_build_relay_payload_with_sender_and_content():
    """sender.name + content 추출."""
    data = {
        "payload": {
            "sender": {"name": "파울로"},
            "content": "안녕하세요",
            "conversation_id": "conv-1",
        }
    }
    text, thread_id, is_conv = _build_relay_payload("conversation:message", data)
    assert text == "[conversation:message] 파울로: 안녕하세요"
    assert thread_id == "conv-1"
    assert is_conv is True


def test_build_relay_payload_thread_id_overrides_conversation_id():
    """thread_id 있으면 conversation_id 대신 사용, is_conversation_event=False."""
    data = {
        "payload": {
            "content": "reply",
            "conversation_id": "conv-1",
            "thread_id": "thread-abc",
        }
    }
    text, thread_id, is_conv = _build_relay_payload("conversation:message", data)
    assert thread_id == "thread-abc"
    assert is_conv is False


# ── relay_to_fakechat ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_relay_skips_non_target_event():
    """비대상 이벤트 — fakechat POST 호출 없음."""
    with patch("sprintable_mcp.sse_bridge.httpx.AsyncClient") as mock_cls:
        await relay_to_fakechat("story_updated", "{}", "http://api", "key", 8787)
        mock_cls.assert_not_called()


@pytest.mark.asyncio
async def test_relay_skips_heartbeat():
    """heartbeat 이벤트 skip."""
    with patch("sprintable_mcp.sse_bridge.httpx.AsyncClient") as mock_cls:
        await relay_to_fakechat("heartbeat", "{}", "http://api", "key", 8787)
        mock_cls.assert_not_called()


@pytest.mark.asyncio
async def test_relay_conversation_message_posts_to_fakechat():
    """conversation:message → fakechat /upload POST 호출."""
    data = json.dumps({
        "payload": {
            "sender": {"name": "테스터"},
            "content": "테스트 메시지",
            "conversation_id": "conv-123",
        }
    })

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("sprintable_mcp.sse_bridge.httpx.AsyncClient", return_value=mock_client):
        await relay_to_fakechat("conversation:message", data, "http://api", "sk-key", 8787)

    mock_client.post.assert_called_once()
    call_args = mock_client.post.call_args
    assert "127.0.0.1:8787" in call_args[0][0]
    form = call_args[1]["data"]
    assert "sse-" in form["id"]
    assert "[conversation:message] 테스터: 테스트 메시지" == form["text"]
    assert form["thread_id"] == "conv-123"
    assert "reply_callback_url" in form


@pytest.mark.asyncio
async def test_relay_swallows_connection_error():
    """fakechat 미가동 시 ConnectionError 삼키기 — 예외 전파 없음."""
    with patch(
        "sprintable_mcp.sse_bridge.httpx.AsyncClient",
        side_effect=Exception("Connection refused"),
    ):
        # 예외가 전파되면 안 됨
        await relay_to_fakechat(
            "conversation:message",
            json.dumps({"payload": {"content": "hi"}}),
            "http://api",
            "key",
            8787,
        )
