"""story #5c29454b(③ 구조화 회신, AC1 발신 계약) — MCP `sprintable_send_chat_message`에
`message_kind` 배선. BE `SendMessageRequest.message_kind`(app/routers/conversations.py,
E-ACTIVATION S1)는 이미 4-enum을 받는데, MCP `SendChatInput`엔 이 필드가 없어 발신측이
kind를 실을 길이 없었다(doc result-card-final-spec-5c29454b가 지목한 근본원인 — FE result
카드 density 레일이 헛돎). 옛 `message_type`(metadata에 얹히던 별개 축)은 BE가 받지 않아 story #4329에서 뺐다.

`test_2618_mcp_mentioned_ids.py`와 동일 컨벤션(mock 기반 payload 배선 확認)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from sprintable_mcp.tools.chat import SendChatInput, send_chat_message
from sprintable_mcp.tools import chat as chat_mod


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_message_kind_forwarded_top_level_to_rest_payload():
    args = SendChatInput(conversation_id="conv-1", content="PASS — 전부 그린", message_kind="result")
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        result = await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["message_kind"] == "result"
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_message_kind_omitted_no_key_in_payload_no_regression():
    """명시 안 하면 payload에 키 자체가 안 실린다 — 조용한 유도 금지(no-fiction), 회귀 0."""
    args = SendChatInput(conversation_id="conv-1", content="hi there")
    assert args.message_kind is None
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert "message_kind" not in kwargs["json"]


@pytest.mark.anyio
async def test_message_kind_rejects_values_outside_4_enum():
    """BE `_ACTIVATION_KINDS`와 동형 4-enum만 허용 — 오탈자/자유문자열은 MCP 경계에서 즉시 422급
    ValidationError(서버 왕복 없이 여기서 잡는다, 헤더 오염 방지 원칙과 동형)."""
    with pytest.raises(ValidationError):
        SendChatInput(conversation_id="conv-1", content="hi", message_kind="done")


@pytest.mark.anyio
async def test_message_kind_is_top_level_and_no_metadata_is_sent():
    """message_kind는 top-level. story #4329 — BE `SendMessageRequest`가 받지 않아 조용히 버려지던 `metadata`(message_type ·
    review_type을 담던 봉투)는 더 싣지 않고, 그 입력은 도구 경계에서 거절된다(extra=forbid — 버려지는 줄 모르고 쓰는 일 0)."""
    args = SendChatInput(conversation_id="conv-1", content="결과 보고", message_kind="result")
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["message_kind"] == "result"
        assert "metadata" not in kwargs["json"]
    for dropped in ({"message_type": "report"}, {"review_type": "design"}, {"metadata": {"k": "v"}}):
        with pytest.raises(ValidationError):
            SendChatInput(conversation_id="conv-1", content="결과 보고", **dropped)
