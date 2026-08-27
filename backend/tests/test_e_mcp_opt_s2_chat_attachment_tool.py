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
    """첨부 없으면 기존 동작 그대로(회귀 0) — payload 에 attachments 키 자체가 없음.

    ⛔story #2294 ③ 후속(2026-07-29): 메시지 전송은 이제 `client.post`가 아니라
    `client.post_full`(unwrap=False, {"data": {...}} 응답의 sibling 보존용)을 쓴다 —
    첨부 업로드(`client.post`)와는 다른 메서드라 각각 따로 mock한다."""
    args = SendChatInput(thread_id="conv-1", content="hi")
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
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
        return upload_result

    async def _fake_post_full(path, json=None):
        calls.append((path, json))
        return {"data": {"id": "m1"}}

    with patch.object(chat_mod.client, "post", new=AsyncMock(side_effect=_fake_post)), \
         patch.object(chat_mod.client, "post_full", new=AsyncMock(side_effect=_fake_post_full)):
        result = await send_chat_message(args)
        assert len(calls) == 2
        assert calls[0][0] == "/api/v2/conversations/conv-1/attachments"
        assert calls[1][0] == "/api/v2/conversations/conv-1/messages"
        assert calls[1][1]["attachments"] == [upload_result]
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_send_chat_message_with_attachment_still_surfaces_references_sideband():
    """⭐PO 질문(2026-07-29) — 첨부가 있을 때도 references가 실리는가? 답: 실린다. 이유:
    첨부는 `payload["attachments"]`에만 영향을 주고, 응답 재구성(`raw.get("data")` +
    sibling 병합)은 첨부 유무와 무관하게 같은 코드 경로다 — 백엔드 메시지 엔드포인트도
    하나뿐이고 그 엔드포인트의 `references` 계산은 `msg.content`(mention 토큰)만 본다,
    `attachments` 필드와 독립. 이 테스트가 그 구조적 주장을 실측으로 고정한다(첨부+
    mention 토큰을 같은 메시지에 같이 넣어 sibling이 살아남는지 직접 본다)."""
    args = SendChatInput(
        thread_id="conv-1", content="[T](entity:task:t-1)",
        attachments=[{"content_base64": _b64(4), "name": "s.png", "content_type": "image/png"}],
    )
    upload_result = {"url": "org/o/project/p/chat/conv-1/x-s.png", "name": "s.png", "content_type": "image/png", "size": 4}
    backend_response = {
        "data": {"id": "m1", "content": "[T](entity:task:t-1)"},
        "references": {"stored": 1, "dropped": []},
    }

    with patch.object(chat_mod.client, "post", new=AsyncMock(return_value=upload_result)), \
         patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=backend_response)) as m_full:
        result = await send_chat_message(args)

    import json
    body = json.loads(result[0].text)
    assert body["id"] == "m1"
    assert body["references"] == {"stored": 1, "dropped": []}
    _, kwargs = m_full.call_args
    assert kwargs["json"]["attachments"] == [upload_result]  # 첨부도 같이 전송됐다


@pytest.mark.anyio
async def test_send_chat_message_surfaces_command_gate_sideband():
    """story #1282 AC2(E-CHAT-CMD follow-up, S6 라이브 검증 2026-06-09 발견) — agent가 MCP로
    `/cmd`를 보냈는데 수신 에이전트 런타임이 그 커맨드를 지원 안 하면, 백엔드는
    `command_gate.blocked[]` hint를 응답 sibling에 싣는다(REST 직접 호출은 이미 받음).
    이 hint가 MCP 경로에서도 살아남는지 — references 테스트(위)와 동일 구조(`references`
    ↔ `command_gate`, 둘 다 story #2294 ③이 도입한 같은 sibling-preserve 메커니즘) — 이
    테스트가 없으면 그 메커니즘이 command_gate 앞에서도 실제로 작동하는지 아무도 값으로
    안 잰 상태였다(AC1 구현 자체는 이미 있었으나 AC2 값-테스트가 없었다)."""
    args = SendChatInput(thread_id="conv-1", content="/deploy")
    backend_response = {
        "data": {"id": "m1", "content": "/deploy"},
        "command_gate": {"blocked": ["deploy"]},
    }

    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value=backend_response)):
        result = await send_chat_message(args)

    import json
    body = json.loads(result[0].text)
    assert body["id"] == "m1"
    assert body["command_gate"] == {"blocked": ["deploy"]}


@pytest.mark.anyio
async def test_send_chat_message_omits_command_gate_when_backend_omits_it():
    """command_gate가 없는(정상 발신) 응답에선 그 키 자체가 결과에 안 생긴다 — 항상
    `{"blocked": []}`류로 조용히 채워 넣지 않는다(있을 때만 surface, 없는 걸 지어내지 않음)."""
    args = SendChatInput(thread_id="conv-1", content="hi")
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})):
        result = await send_chat_message(args)

    import json
    body = json.loads(result[0].text)
    assert "command_gate" not in body


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

    with patch.object(chat_mod.client, "post", new=AsyncMock(side_effect=_fake_post)), \
         patch.object(chat_mod.client, "post_full", new=AsyncMock()) as m_full:
        result = await send_chat_message(args)
        assert calls == ["/api/v2/conversations/conv-1/attachments"]
        m_full.assert_not_awaited()  # 업로드 실패 시 메시지 생성 자체를 시도하지 않는다
        assert result[0].text.startswith("Error")


@pytest.mark.anyio
async def test_send_chat_message_partial_failure_logs_orphan_warning(caplog):
    """업로드 성공 後 메시지 생성 실패 — orphan blob 발생, 운영 가시성 위해 경고 로그."""
    args = SendChatInput(
        thread_id="conv-1", content="x",
        attachments=[{"content_base64": _b64(4), "name": "s.png", "content_type": "image/png"}],
    )
    upload_result = {"url": "org/o/project/p/chat/conv-1/x-s.png", "name": "s.png", "content_type": "image/png", "size": 4}

    with caplog.at_level(logging.WARNING, logger=chat_mod.logger.name):
        with patch.object(chat_mod.client, "post", new=AsyncMock(return_value=upload_result)), \
             patch.object(chat_mod.client, "post_full", new=AsyncMock(side_effect=RuntimeError("message create failed"))):
            result = await send_chat_message(args)
    assert result[0].text.startswith("Error")
    assert any("orphaned" in r.message for r in caplog.records)
