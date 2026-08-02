"""story #2427 — send/list/get_chat_message의 request `thread_id`가 실은 conversation_id를
뜻했는데, 이 셋의 응답은 백엔드 `_msg_payload()`가 `conversation_id`·`thread_id`(진짜 회신
스레드, 보통 null) 필드를 «둘 다» 싣는다 — 같은 이름이 요청·응답에서 다른 것을 가리켰다.

처방: 요청 쪽 정식 이름을 `conversation_id`로 맞추고, `thread_id`는 폐기 예정 별칭으로
받는다(extra="forbid"와 안 부딪힌다 — 둘 다 «선언된» 필드). 둘 다 왔는데 값이 다르면 거부.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from sprintable_mcp.tools.chat import (
    GetChatMessageInput,
    ListChatMessagesInput,
    SendChatInput,
    get_chat_message,
    send_chat_message,
)

CONV = "11111111-1111-1111-1111-111111111111"
OTHER = "99999999-9999-9999-9999-999999999999"


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 스키마 레벨 — conversation_id/thread_id 해소 ────────────────────────────

class TestConversationIdResolution:
    def test_conversation_id_alone_resolves(self):
        i = SendChatInput(conversation_id=CONV, content="hi")
        assert i.conversation_id == CONV

    def test_thread_id_alone_still_works_backward_compat(self):
        # 기존 호출부(예: test_mcp_get_chat_message_3cf50d90.py)가 thread_id=만 쓴다 — 안 깨져야 한다.
        i = GetChatMessageInput(thread_id=CONV, message_id="m1")
        assert i.conversation_id == CONV

    def test_both_same_value_passes(self):
        # 음성대조(PO 요청) — ③이 과잉거부로 가면 안 된다.
        i = ListChatMessagesInput(conversation_id=CONV, thread_id=CONV)
        assert i.conversation_id == CONV

    def test_both_different_values_rejected(self):
        # 양성대조 — 이 축의 값. 조용히 하나를 고르면 이 스토리가 없애려는 병이 되살아난다.
        with pytest.raises(ValidationError, match="다릅니다"):
            SendChatInput(conversation_id=CONV, thread_id=OTHER, content="hi")

    def test_neither_provided_rejected(self):
        with pytest.raises(ValidationError, match="conversation_id가 필요"):
            SendChatInput(content="hi")

    def test_extra_forbid_unaffected(self):
        # story #2412 lockdown과 안 부딪히는지 — 미선언 인자는 여전히 거부된다.
        with pytest.raises(ValidationError):
            SendChatInput(conversation_id=CONV, content="hi", bogus_field="x")


class TestDeprecatedAliasUsageCounter:
    """PO 요청(2026-08-02, #2799 리뷰) — 「걷을 조건」은 잴 수 있어야 선언이다.
    thread_id로 들어오면 경고 로그가 남아야 나중에 "0에 수렴했는가"를 셀 수 있다."""

    def test_thread_id_only_logs_deprecation_warning(self, caplog):
        import logging
        with caplog.at_level(logging.WARNING, logger="sprintable_mcp.tools.chat"):
            SendChatInput(thread_id=CONV, content="hi")
        assert any("deprecated thread_id alias" in r.message for r in caplog.records)
        assert any(r.levelno == logging.WARNING for r in caplog.records)

    def test_conversation_id_only_does_not_log(self, caplog):
        """음성대조 — 정식 이름을 쓰면 카운터가 조용해야 한다(안 그러면 카운터가 항상 시끄러워
        「0에 수렴」을 못 판별한다)."""
        import logging
        with caplog.at_level(logging.WARNING, logger="sprintable_mcp.tools.chat"):
            SendChatInput(conversation_id=CONV, content="hi")
        assert not any("deprecated thread_id alias" in r.message for r in caplog.records)

    def test_both_same_value_does_not_log(self, caplog):
        """둘 다 주어졌고 conversation_id를 이미 쓰고 있다면 별칭에 «의존»하는 게 아니다 —
        경고는 "conversation_id 없이 thread_id만" 자리에서만 의미가 있다."""
        import logging
        with caplog.at_level(logging.WARNING, logger="sprintable_mcp.tools.chat"):
            SendChatInput(conversation_id=CONV, thread_id=CONV, content="hi")
        assert not any("deprecated thread_id alias" in r.message for r in caplog.records)


# ─── 판별(PO 요청) — 응답을 보고 그대로 다시 부르면 통하는가 ──────────────────

class TestResponseRoundTrip:
    @pytest.mark.anyio
    async def test_calling_again_with_response_conversation_id_works(self):
        """이 결함의 정의를 뒤집어 pin — 고친 뒤 이게 «예»여야 닫힌다."""
        msg_resp = {
            "id": "m1", "conversation_id": CONV, "thread_id": None,
            "content": "hello", "sender": {"id": "s", "name": "디디", "type": "agent"},
        }
        with patch("sprintable_mcp.tools.chat.client") as mock_client:
            mock_client.get = AsyncMock(return_value=msg_resp)
            out = await get_chat_message(GetChatMessageInput(conversation_id=CONV, message_id="m1"))
        parsed = json.loads(out[0].text)

        # 응답의 conversation_id를 그대로 다시 넣는다 — 이게 이제 자연스럽고 맞는 다음 행동이다.
        again = GetChatMessageInput(conversation_id=parsed["conversation_id"], message_id="m1")
        assert again.conversation_id == CONV

    def test_naively_reusing_response_thread_id_alone_now_fails_loudly_not_silently(self):
        """예전엔 응답의 thread_id(=None, 회신스레드)를 실수로 재사용하면 URL에
        "None"이 박혀 조용히 엉뚱한 404로 샜다. 지금은 필수값 누락으로 «즉시» 명확하게 막힌다
        — 조용한 오류가 시끄러운 오류로 바뀐 것이 이 스토리의 값이다."""
        msg_resp_thread_id = None  # 최상위 메시지는 항상 이렇다(회신 아님).
        with pytest.raises(ValidationError, match="conversation_id가 필요"):
            GetChatMessageInput(thread_id=msg_resp_thread_id, message_id="m1")


# ─── 전 경로(Tool.run) — 실 등록 도구까지 태워 회귀가 없는지 ───────────────────

class TestRegisteredToolEndToEnd:
    @pytest.mark.anyio
    async def test_send_chat_message_tool_accepts_conversation_id(self):
        from sprintable_mcp import server as srv

        tool = srv.mcp._tool_manager.get_tool("sprintable_send_chat_message")
        with patch("sprintable_mcp.tools.chat.client") as mock_client:
            mock_client.post_full = AsyncMock(return_value={
                "data": {"id": "m1", "conversation_id": CONV, "thread_id": None, "content": "hi"},
            })
            result = await tool.run({"conversation_id": CONV, "content": "hi"})
        assert isinstance(result, list)

    @pytest.mark.anyio
    async def test_send_chat_message_tool_rejects_the_old_bug_shape(self):
        """실물 재현 — story #2427의 발단 그대로: conversation_id를 넘긴 옛 습관이 아니라
        thread_id/conversation_id를 «둘 다·다른 값으로» 넘기는 자리를 통한 도구 경로 회귀 확認."""
        from sprintable_mcp import server as srv
        from mcp.server.fastmcp.exceptions import ToolError

        tool = srv.mcp._tool_manager.get_tool("sprintable_send_chat_message")
        with pytest.raises(ToolError):
            await tool.run({"conversation_id": CONV, "thread_id": OTHER, "content": "hi"})

    @pytest.mark.anyio
    async def test_send_chat_message_tool_still_accepts_legacy_thread_id_only(self):
        """회귀 방지 — 기존 호출부가 thread_id=만 쓰던 습관이 안 깨져야 한다."""
        from sprintable_mcp import server as srv

        tool = srv.mcp._tool_manager.get_tool("sprintable_send_chat_message")
        with patch("sprintable_mcp.tools.chat.client") as mock_client:
            mock_client.post_full = AsyncMock(return_value={
                "data": {"id": "m1", "conversation_id": CONV, "thread_id": None, "content": "hi"},
            })
            result = await tool.run({"thread_id": CONV, "content": "hi"})
        assert isinstance(result, list)
