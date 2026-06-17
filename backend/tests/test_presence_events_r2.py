"""R2(da9d1781): presence/working SSE 발행 헬퍼 — shape + best-effort(실패 swallow)."""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest


def test_emit_conversation_working_publishes_shape():
    from app.services import presence_events

    org = uuid.uuid4()
    conv = uuid.uuid4()
    with patch("app.routers.events.publish_event") as pub, patch(
        "app.services.chat_presence.list_working", return_value=[{"member_id": "m1"}]
    ):
        presence_events.emit_conversation_working(org, conv)
    pub.assert_called_once()
    args = pub.call_args.args
    assert args[0] == str(org)
    assert args[1] == "conversation.working"
    assert args[2]["conversation_id"] == str(conv)
    assert args[2]["working"] == [{"member_id": "m1"}]


def test_emit_presence_publishes_trigger():
    from app.services import presence_events

    org = uuid.uuid4()
    with patch("app.routers.events.publish_event") as pub:
        presence_events.emit_presence(org)
    pub.assert_called_once()
    args = pub.call_args.args
    assert args[0] == str(org)
    assert args[1] == "presence"
    assert args[2] == {}


def test_emit_best_effort_swallows_publish_failure():
    """발행 실패가 caller 흐름을 깨면 안 됨(메시지 dispatch/reply 보호) — 예외 swallow."""
    from app.services import presence_events

    with patch("app.routers.events.publish_event", side_effect=RuntimeError("bus down")):
        # 예외 전파 없이 정상 반환해야 한다.
        presence_events.emit_presence(uuid.uuid4())
        presence_events.emit_conversation_working(uuid.uuid4(), uuid.uuid4())


def test_emit_working_swallows_list_working_failure():
    from app.services import presence_events

    with patch("app.routers.events.publish_event"), patch(
        "app.services.chat_presence.list_working", side_effect=RuntimeError("boom")
    ):
        presence_events.emit_conversation_working(uuid.uuid4(), uuid.uuid4())  # no raise


def test_clear_member_returns_affected_conversations():
    """QA HIGH(#1570): disconnect 시 working 비운 대화 목록 반환 → caller 가 conversation.working 발행."""
    from app.services import chat_presence

    conv_a, conv_b, conv_c = "conv-a", "conv-b", "conv-c"
    mid = "agent-x"
    other = "agent-y"
    chat_presence.set_working(conv_a, mid)
    chat_presence.set_working(conv_b, mid)
    chat_presence.set_working(conv_b, other)  # conv_b 엔 다른 agent 도 working
    chat_presence.set_working(conv_c, other)  # mid 와 무관

    affected = chat_presence.clear_member(mid)
    assert set(affected) == {conv_a, conv_b}  # mid 가 working 이던 대화만(conv_c 제외)
    # conv_b 는 other 가 남아 비지 않음·conv_a 는 비워짐 — 둘 다 affected(working 변경됨)
    chat_presence.clear_member(other)  # cleanup
