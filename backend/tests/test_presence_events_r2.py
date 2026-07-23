"""R2(da9d1781): presence/working SSE 발행 헬퍼 — shape + best-effort(실패 swallow).

story #2139/#2132(2026-07-23) 근본수정 반영: 구 `events.publish_event()`(org-level
`_subscribers` fanout — 아무도 구독 안 하는 영구 죽은 코드)를 삭제하고
`events.push_to_org_members()`(`_push_to_agent()` 개별 push로 귀결 — 실제 배달 경로)로
교체됐다. 수신자 스코프가 이벤트별로 다르다(presence=org 전체, conversation.working=참가자만)
— 그 스코프 차이가 이 테스트의 핵심 축이다."""
from __future__ import annotations

import contextlib
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _patch_session_factory(participant_ids: list[str]):
    """async_session_factory()를 mock async context manager로 대체 — ConversationParticipant
    조회 결과로 participant_ids를 반환하게 한다(test_agent_gateway.py의 헬퍼와 동형)."""
    db = MagicMock()
    result = MagicMock()
    result.all.return_value = [(uuid.UUID(pid) if _looks_like_uuid(pid) else pid,) for pid in participant_ids]
    db.execute = AsyncMock(return_value=result)

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    return _factory, db


def _looks_like_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False


@pytest.mark.anyio
async def test_emit_conversation_working_publishes_shape():
    """conversation.working은 **참가자만**에게 간다(org 전체 아님) — #2139 §3 확定."""
    from app.services import presence_events

    org = uuid.uuid4()
    conv = uuid.uuid4()
    participant_id = str(uuid.uuid4())
    factory, _db = _patch_session_factory([participant_id])

    with patch("app.core.database.async_session_factory", factory), \
         patch("app.services.chat_presence.list_working", new=AsyncMock(return_value=[{"member_id": "m1"}])), \
         patch("app.routers.events.push_to_org_members", new=AsyncMock()) as pub:
        await presence_events.emit_conversation_working(org, conv)

    pub.assert_awaited_once()
    args, kwargs = pub.await_args
    assert args[0] == str(org)
    assert args[1] == "conversation.working"
    assert args[2]["conversation_id"] == str(conv)
    assert args[2]["working"] == [{"member_id": "m1"}]
    # ⭐핵심 회귀가드 — member_ids가 명시(참가자만)이지 None(org 전체)이 아니어야 한다.
    assert kwargs["member_ids"] == {participant_id}


@pytest.mark.anyio
async def test_emit_presence_publishes_trigger():
    """presence는 **org 전체**에게 간다 — member_ids를 명시하지 않아 push_to_org_members가
    org_members 전체를 자체 해소하게 한다(#2139 §3 확定)."""
    from app.services import presence_events

    org = uuid.uuid4()
    with patch("app.routers.events.push_to_org_members", new=AsyncMock()) as pub:
        await presence_events.emit_presence(org)

    pub.assert_awaited_once()
    args, kwargs = pub.await_args
    assert args[0] == str(org)
    assert args[1] == "presence"
    assert args[2] == {}
    # ⭐핵심 회귀가드 — member_ids를 넘기지 않아야 org 전체로 해소된다(참가자만으로 좁히면 안 됨).
    assert kwargs.get("member_ids") is None


@pytest.mark.anyio
async def test_emit_best_effort_swallows_publish_failure():
    """발행 실패가 caller 흐름을 깨면 안 됨(메시지 dispatch/reply 보호) — 예외 swallow."""
    from app.services import presence_events

    with patch("app.routers.events.push_to_org_members", new=AsyncMock(side_effect=RuntimeError("bus down"))):
        await presence_events.emit_presence(uuid.uuid4())  # no raise

    factory, _db = _patch_session_factory([])
    with patch("app.core.database.async_session_factory", factory), \
         patch("app.routers.events.push_to_org_members", new=AsyncMock(side_effect=RuntimeError("bus down"))):
        await presence_events.emit_conversation_working(uuid.uuid4(), uuid.uuid4())  # no raise


@pytest.mark.anyio
async def test_emit_working_swallows_list_working_failure():
    from app.services import presence_events

    factory, _db = _patch_session_factory([])
    with patch("app.core.database.async_session_factory", factory), \
         patch("app.routers.events.push_to_org_members", new=AsyncMock()), \
         patch("app.services.chat_presence.list_working", new=AsyncMock(side_effect=RuntimeError("boom"))):
        await presence_events.emit_conversation_working(uuid.uuid4(), uuid.uuid4())  # no raise


@pytest.mark.anyio
async def test_clear_member_returns_affected_conversations():
    """QA HIGH(#1570): disconnect 시 working 비운 대화 목록 반환 → caller 가 conversation.working 발행."""
    from app.services import chat_presence

    conv_a, conv_b, conv_c = "conv-a", "conv-b", "conv-c"
    mid = "agent-x"
    other = "agent-y"
    await chat_presence.set_working(conv_a, mid)
    await chat_presence.set_working(conv_b, mid)
    await chat_presence.set_working(conv_b, other)  # conv_b 엔 다른 agent 도 working
    await chat_presence.set_working(conv_c, other)  # mid 와 무관

    affected = await chat_presence.clear_member(mid)
    assert set(affected) == {conv_a, conv_b}  # mid 가 working 이던 대화만(conv_c 제외)
    # conv_b 는 other 가 남아 비지 않음·conv_a 는 비워짐 — 둘 다 affected(working 변경됨)
    await chat_presence.clear_member(other)  # cleanup
