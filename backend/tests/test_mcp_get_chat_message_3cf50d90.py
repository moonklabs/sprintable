"""story 3cf50d90: MCP sprintable_get_chat_message — 웹훅 payload 잘림 시 message_id로
즉시 원문 픽업(재발신 요청 왕복 대체)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_get_chat_message_returns_content_and_calls_single_message_path():
    from sprintable_mcp.tools.chat import GetChatMessageInput, get_chat_message

    thread_id = "11111111-1111-1111-1111-111111111111"
    message_id = "22222222-2222-2222-2222-222222222222"
    msg_resp = {
        "id": message_id, "conversation_id": thread_id, "thread_id": None,
        "content": "원문 전체 내용 — 잘리지 않음",
        "sender": {"id": "s", "name": "디디", "type": "agent"},
    }
    calls: list[str] = []

    async def fake_get(path, params=None):
        calls.append(path)
        return msg_resp

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await get_chat_message(GetChatMessageInput(thread_id=thread_id, message_id=message_id))

    parsed = json.loads(out[0].text)
    assert parsed["content"] == "원문 전체 내용 — 잘리지 않음"
    assert calls == [f"/api/v2/conversations/{thread_id}/messages/{message_id}"]


@pytest.mark.anyio
async def test_get_chat_message_reply_also_resolves():
    """리플 메시지도 동일 엔드포인트로 조회(top-level/리플 공용 회귀 가드)."""
    from sprintable_mcp.tools.chat import GetChatMessageInput, get_chat_message

    thread_id = "11111111-1111-1111-1111-111111111111"
    parent_id = "33333333-3333-3333-3333-333333333333"
    reply_id = "44444444-4444-4444-4444-444444444444"
    reply_resp = {
        "id": reply_id, "conversation_id": thread_id, "thread_id": parent_id,
        "content": "리플 원문", "sender": {"id": "s", "name": "디디", "type": "agent"},
    }

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.get = AsyncMock(return_value=reply_resp)
        out = await get_chat_message(GetChatMessageInput(thread_id=thread_id, message_id=reply_id))

    parsed = json.loads(out[0].text)
    assert parsed["content"] == "리플 원문"
    assert parsed["thread_id"] == parent_id


@pytest.mark.anyio
async def test_get_chat_message_error_surfaces():
    from sprintable_mcp.tools.chat import GetChatMessageInput, get_chat_message

    with patch("sprintable_mcp.tools.chat.client") as mock_client:
        mock_client.get = AsyncMock(side_effect=Exception("404 Not Found"))
        out = await get_chat_message(GetChatMessageInput(thread_id="x", message_id="y"))

    assert "error" in out[0].text.lower()
