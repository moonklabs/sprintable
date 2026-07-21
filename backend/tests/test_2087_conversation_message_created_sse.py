"""story #2086 후속(2026-07-21, 전수 스윕 발견): `conversation.message_created`가 SSE로 안 감 —
`publish_event()`의 org `_subscribers` fanout은 영구 죽은 레지스트리(story #2059/#2067과 동일
근본)라 `use-chat-sse.ts`의 `conversation.message_created` 리스너(대화 목록 갱신)에 실제로는
아무것도 안 갔다. `_push_conversation_message_created()`가 `pending_sse_pushes`와 동일 참가자
집합(dedup)에게 개별 push하도록 복구한다.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest

from app.routers.conversations import _push_conversation_message_created


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_pushes_once_per_unique_participant():
    """참가자 push와 멘션 push가 같은 pid를 중복 포함해도(participant ⊇ mention 겹침 가능)
    conversation.message_created는 pid당 1회만 나가야."""
    p1, p2 = str(uuid.uuid4()), str(uuid.uuid4())
    pending_sse_pushes = [
        (p1, {"event_type": "chat:message", "id": "m1"}),  # participant push
        (p2, {"event_type": "chat:message", "id": "m1"}),  # participant push
        (p1, {"event_type": "conversation:mention", "id": "m1"}),  # p1이 멘션도 됨(중복)
    ]
    pushed_calls = []
    with patch(
        "app.routers.conversations._push_to_agent",
        lambda pid, payload: pushed_calls.append((pid, payload)),
    ):
        _push_conversation_message_created(pending_sse_pushes, {"id": "m1", "content": "hi"})

    assert len(pushed_calls) == 2  # p1 1회 + p2 1회(dedup) — 3개 입력이 2개 push로
    pids_pushed = {pid for pid, _ in pushed_calls}
    assert pids_pushed == {p1, p2}
    for _, payload in pushed_calls:
        assert payload["event_type"] == "conversation.message_created"
        assert payload["content"] == "hi"


def test_no_pushes_when_no_recipients():
    pushed_calls = []
    with patch(
        "app.routers.conversations._push_to_agent",
        lambda pid, payload: pushed_calls.append((pid, payload)),
    ):
        _push_conversation_message_created([], {"id": "m1"})
    assert pushed_calls == []


def test_payload_is_copied_per_recipient_not_shared_mutable():
    """수신자마다 dict 사본이어야(한 명의 로컬 mutation이 다른 수신자 payload에 안 새도록)."""
    p1, p2 = str(uuid.uuid4()), str(uuid.uuid4())
    pending_sse_pushes = [(p1, {}), (p2, {})]
    captured = []
    with patch(
        "app.routers.conversations._push_to_agent",
        lambda pid, payload: captured.append(payload),
    ):
        _push_conversation_message_created(pending_sse_pushes, {"id": "m1"})

    assert len(captured) == 2
    captured[0]["mutated"] = True
    assert "mutated" not in captured[1]
