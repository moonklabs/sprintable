"""E-MCP-OPT S2 (bbfd24ba): `sprintable_send_chat_message` inline base64 첨부 — MCP 쪽 검증.

client-side fail-fast 가드(개수/사이즈/base64) + 업로드→메시지 체이닝 + 회귀(첨부 없으면
기존 payload 그대로) + 부분실패(업로드 성공·메시지 실패) 시 orphan 로그.
"""
from __future__ import annotations

import base64
import logging
from unittest.mock import AsyncMock, patch

import pytest

from sprintable_mcp.tools import attachments as attachments_mod
from sprintable_mcp.tools import chat as chat_mod
from sprintable_mcp.tools.attachments import upload_attachments as _upload_attachments
from sprintable_mcp.tools.attachments import validate_attachment as _validate_attachment
from sprintable_mcp.tools.chat import SendChatInput, send_chat_message


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _b64(n: int) -> str:
    return base64.b64encode(b"x" * n).decode()


# ── _validate_attachment ──────────────────────────────────────────────────────
def test_validate_attachment_accepts_valid():
    payload, size = _validate_attachment(
        {"content_base64": _b64(10), "name": "a.png", "content_type": "image/png"}, 0
    )
    assert size == 10
    assert payload == {"content_base64": _b64(10), "name": "a.png", "content_type": "image/png"}


def test_validate_attachment_missing_fields_raise():
    with pytest.raises(ValueError, match="name is required"):
        _validate_attachment({"content_base64": _b64(1), "content_type": "text/plain"}, 0)
    with pytest.raises(ValueError, match="content_type is required"):
        _validate_attachment({"content_base64": _b64(1), "name": "a"}, 0)
    with pytest.raises(ValueError, match="content_base64 is required"):
        _validate_attachment({"name": "a", "content_type": "text/plain"}, 0)


def test_validate_attachment_invalid_base64_raises():
    with pytest.raises(ValueError, match="must be valid base64"):
        _validate_attachment({"content_base64": "not-base64!!!", "name": "a", "content_type": "t"}, 0)


def test_validate_attachment_empty_content_base64_raises():
    with pytest.raises(ValueError, match="content_base64 is required"):
        _validate_attachment({"content_base64": "", "name": "a", "content_type": "t"}, 0)


def test_validate_attachment_oversized_rejected_before_full_decode():
    too_big = _b64(attachments_mod.MAX_ATTACHMENT_BYTES + 1)
    with pytest.raises(ValueError, match="too large"):
        _validate_attachment({"content_base64": too_big, "name": "a", "content_type": "t"}, 0)


# ── _upload_attachments ───────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_upload_attachments_empty_returns_empty():
    assert await _upload_attachments("/api/v2/conversations/conv-1/attachments", None) == []
    assert await _upload_attachments("/api/v2/conversations/conv-1/attachments", []) == []


@pytest.mark.anyio
async def test_upload_attachments_too_many_rejected():
    atts = [{"content_base64": _b64(1), "name": f"{i}", "content_type": "t"} for i in range(attachments_mod.MAX_ATTACHMENTS + 1)]
    with pytest.raises(ValueError, match="too many attachments"):
        await _upload_attachments("/api/v2/conversations/conv-1/attachments", atts)


@pytest.mark.anyio
async def test_upload_attachments_total_size_exceeded_rejected_before_any_network_call():
    """총량 초과는 업로드 시작 前 전부 검증되어 걸러진다 — client.post 가 단 한 번도 안 불림
    (마지막 파일에서만 드러나는 초과였다면 앞선 파일들이 실제 업로드→orphan 되는 낭비 없음)."""
    per_file = attachments_mod.MAX_ATTACHMENT_BYTES
    atts = [{"content_base64": _b64(per_file), "name": f"{i}", "content_type": "t"} for i in range(4)]
    assert len(atts) <= attachments_mod.MAX_ATTACHMENTS
    assert per_file * 4 > attachments_mod.MAX_TOTAL_ATTACHMENT_BYTES
    with patch.object(chat_mod.client, "post", new=AsyncMock()) as m:
        with pytest.raises(ValueError, match="total too large"):
            await _upload_attachments("/api/v2/conversations/conv-1/attachments", atts)
        m.assert_not_awaited()


@pytest.mark.anyio
async def test_upload_attachments_calls_endpoint_per_file():
    atts = [{"content_base64": _b64(5), "name": "a.png", "content_type": "image/png"}]
    fake_result = {"url": "org/o/project/p/chat/c/x-a.png", "name": "a.png", "content_type": "image/png", "size": 5}
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value=fake_result)) as m:
        result = await _upload_attachments("/api/v2/conversations/conv-1/attachments", atts)
        assert result == [fake_result]
        m.assert_awaited_once_with(
            "/api/v2/conversations/conv-1/attachments",
            json={"content_base64": _b64(5), "name": "a.png", "content_type": "image/png"},
        )


# ── send_chat_message 회귀 + 체이닝 ────────────────────────────────────────────
@pytest.mark.anyio
async def test_send_chat_message_no_attachments_unchanged_payload():
    """첨부 없으면 기존 동작 그대로(회귀 0) — payload 에 attachments 키 자체가 없음."""
    args = SendChatInput(thread_id="conv-1", content="hi")
    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value={"id": "m1"})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert "attachments" not in kwargs["json"]


@pytest.mark.anyio
async def test_send_chat_message_uploads_then_sends_with_attachments():
    args = SendChatInput(
        thread_id="conv-1", content="screenshot",
        attachments=[{"content_base64": _b64(4), "name": "s.png", "content_type": "image/png"}],
    )
    upload_result = {"url": "org/o/project/p/chat/conv-1/x-s.png", "name": "s.png", "content_type": "image/png", "size": 4}
    calls: list[tuple] = []

    async def _fake_post(path, json=None):
        calls.append((path, json))
        if path.endswith("/attachments"):
            return upload_result
        return {"id": "m1"}

    with patch.object(chat_mod.client, "post", new=AsyncMock(side_effect=_fake_post)):
        result = await send_chat_message(args)
        assert len(calls) == 2
        assert calls[0][0] == "/api/v2/conversations/conv-1/attachments"
        assert calls[1][0] == "/api/v2/conversations/conv-1/messages"
        assert calls[1][1]["attachments"] == [upload_result]
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_upload_failure_does_not_call_message_create():
    args = SendChatInput(
        thread_id="conv-1", content="x",
        attachments=[{"content_base64": _b64(4), "name": "s.png", "content_type": "image/png"}],
    )
    calls: list[str] = []

    async def _fake_post(path, json=None):
        calls.append(path)
        raise RuntimeError("upload 403")

    with patch.object(chat_mod.client, "post", new=AsyncMock(side_effect=_fake_post)):
        result = await send_chat_message(args)
        assert calls == ["/api/v2/conversations/conv-1/attachments"]
        assert result[0].text.startswith("Error")


@pytest.mark.anyio
async def test_send_chat_message_partial_failure_logs_orphan_warning(caplog):
    """업로드 성공 後 메시지 생성 실패 — orphan blob 발생, 운영 가시성 위해 경고 로그."""
    args = SendChatInput(
        thread_id="conv-1", content="x",
        attachments=[{"content_base64": _b64(4), "name": "s.png", "content_type": "image/png"}],
    )
    upload_result = {"url": "org/o/project/p/chat/conv-1/x-s.png", "name": "s.png", "content_type": "image/png", "size": 4}

    async def _fake_post(path, json=None):
        if path.endswith("/attachments"):
            return upload_result
        raise RuntimeError("message create failed")

    with caplog.at_level(logging.WARNING, logger=chat_mod.logger.name):
        with patch.object(chat_mod.client, "post", new=AsyncMock(side_effect=_fake_post)):
            result = await send_chat_message(args)
    assert result[0].text.startswith("Error")
    assert any("orphaned" in r.message for r in caplog.records)
