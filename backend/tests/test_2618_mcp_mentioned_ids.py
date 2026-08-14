"""story #2618(페드루 판정, 2026-08-14) — MCP `sprintable_send_chat_message`에 팀원 구조화
멘션(`mentioned_ids`) 배선. REST `SendMessageRequest.mentioned_ids`(app/routers/
conversations.py)는 이미 있고 FE 피커도 실제로 채워 보내는데(`chat-input.tsx`), MCP
`SendChatInput`엔 entity-참조용 `mentions`만 있고 이 필드가 없었다 — 에이전트는 구조화
팀원 멘션을 못 보냈다.

②그라운딩에서 확認한 4개 소비처(channel_router.py mentions-레벨 알림게이팅·전용
conversation.mention SSE+알림/푸시·DM 비참가자 멘션 시 group 자동포크·체인뎁스 초과 시
human_intervention 타깃 한정) 중 「소비처 없는 파라미터로 끝나는」 #2636 (b)안류 반쪽을
막기 위해, PO AC 추가: MCP로 mentioned_ids를 실어 발신 → 실제 conversation.mention 알림이
생성되는 것까지 실물로 확認한다(전달만 뚫린 반쪽 금지) — `test_mcp_send_chat_message_
mentioned_ids_creates_real_conversation_mention_notification`이 그 실물 round-trip.

앞쪽(mock 기반)은 기존 `test_mcp_s1995_agent_doc_mentions.py`와 동일 컨벤션 — MCP 계층이
`mentioned_ids`를 REST payload에 그대로 실어 보내는지, 생략 시 회귀 0인지."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from sprintable_mcp.tools.chat import SendChatInput, send_chat_message
from sprintable_mcp.tools import chat as chat_mod


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── MCP 계층 배선(mock) ─────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_mentioned_ids_forwarded_verbatim_to_rest_payload():
    args = SendChatInput(
        conversation_id="conv-1", content="hey @you",
        mentioned_ids=["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"],
    )
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        result = await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["mentioned_ids"] == [
            "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222",
        ]
        assert "Error" not in result[0].text


@pytest.mark.anyio
async def test_mentioned_ids_omitted_byte_identical_no_regression():
    """기존 호출자(mentioned_ids 미지정)는 payload에 그 키 자체가 안 실린다 — 회귀 0."""
    args = SendChatInput(conversation_id="conv-1", content="hi there")
    assert args.mentioned_ids is None
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert "mentioned_ids" not in kwargs["json"]


@pytest.mark.anyio
async def test_mentioned_ids_empty_list_omitted_from_payload():
    args = SendChatInput(conversation_id="conv-1", content="hi there", mentioned_ids=[])
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert "mentioned_ids" not in kwargs["json"]


@pytest.mark.anyio
async def test_mentioned_ids_coexists_with_entity_mentions():
    """entity mentions(mentions)와 팀원 mentions(mentioned_ids)는 서로 다른 축 — 공존 확認."""
    args = SendChatInput(
        conversation_id="conv-1", content="see this",
        mentions=[{"type": "doc", "id": "doc-1", "title": "My Doc"}],
        mentioned_ids=["11111111-1111-1111-1111-111111111111"],
    )
    with patch.object(chat_mod.client, "post_full", new=AsyncMock(return_value={"data": {"id": "m1"}})) as m:
        await send_chat_message(args)
        _, kwargs = m.call_args
        assert kwargs["json"]["content"] == "see this [My Doc](entity:doc:doc-1) "
        assert kwargs["json"]["mentioned_ids"] == ["11111111-1111-1111-1111-111111111111"]


@pytest.mark.anyio
async def test_invalid_uuid_mentioned_id_surfaces_as_error_not_swallowed():
    """AC2 — 잘못된 id는 REST의 pydantic UUID 강제변환으로 422 나고, MCP가 그 에러를
    삼키지 않고 그대로 노출하는지(err() 응답에 상세가 실린다)."""
    from sprintable_mcp.api_client import SprintableApiError

    args = SendChatInput(conversation_id="conv-1", content="hi", mentioned_ids=["not-a-uuid"])
    with patch.object(
        chat_mod.client, "post_full",
        new=AsyncMock(side_effect=SprintableApiError(422, "mentioned_ids: invalid UUID", body={})),
    ):
        result = await send_chat_message(args)
    assert result[0].text.startswith("Error")
    assert "422" in result[0].text or "invalid" in result[0].text.lower()


# ── 실물 round-trip(AC 추가분) — mentioned_ids가 실제로 conversation.mention 알림을 만드는지 ──
def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _session_factory():
    import os
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    url = (__import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL"))
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _setup_app_agent(app, Session, agent_member_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(agent_member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _notification_count_for(session, user_id, event_type):
    from sqlalchemy import func, select
    from app.models.notification import Notification
    return (await session.execute(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id, Notification.type == event_type,
        )
    )).scalar_one()


_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")


@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
@pytest.mark.anyio
async def test_mcp_send_chat_message_mentioned_ids_creates_real_conversation_mention_notification():
    """PO 추가 AC — 「전달만 뚫린 반쪽」 방지 실왕복. `send_chat_message()`(실 MCP 함수,
    unmock)가 진짜 FastAPI 앱(ASGITransport)+실 DB로 나가게 하고, 그 결과 수신자에게
    conversation.mention 알림이 실제로 생성되는지까지 잰다 — REST payload 전달 확認에서
    멈추지 않는다."""
    import httpx
    from httpx import ASGITransport
    from app.main import app
    from tests.test_1994_backlink_api_realdb import (
        _make_agent_member, _make_conversation, _make_human_member, _make_org, _make_project,
    )

    engine, Session = await _session_factory()
    _RealAsyncClient = httpx.AsyncClient
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            sender_agent_id = await _make_agent_member(s, org.id, project.id)
            recipient_member_id, recipient_user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(
                s, org.id, project.id, [sender_agent_id, recipient_member_id],
                created_by=sender_agent_id, conv_type="group",
            )

        await _setup_app_agent(app, Session, sender_agent_id, org.id)

        def _asgi_async_client(*args, **kwargs):
            kwargs["transport"] = ASGITransport(app=app)
            return _RealAsyncClient(*args, **kwargs)

        chat_mod.client._base_url = "http://test"
        chat_mod.client._api_key = "test-key"
        chat_mod.client._org_id = str(org.id)

        args = SendChatInput(
            conversation_id=str(conv_id), content="hey, need your input",
            mentioned_ids=[str(recipient_member_id)],
        )

        with patch("sprintable_mcp.api_client.httpx.AsyncClient", new=_asgi_async_client):
            result = await send_chat_message(args)

        assert "Error" not in result[0].text, result[0].text

        async with Session() as s:
            mention_count = await _notification_count_for(s, recipient_user_id, "conversation.mention")
            assert mention_count == 1, "MCP로 실은 mentioned_ids가 실제 conversation.mention 알림을 못 만들었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
