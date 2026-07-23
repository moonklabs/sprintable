"""story #2139/#2132(2026-07-23) 근본수정 — `events.push_to_org_members()`가 실제로
`_agent_connections`(실 SSE 배달 레지스트리)에 도착하는 것을 실 큐로 고정한다(mock 없이).

배경: 구 `publish_event()`는 `_subscribers[org_id]`(아무도 `.add()`하지 않는 영구 죽은
레지스트리)에만 넣었다 — 실 배달 경로는 항상 `_agent_connections[member_id]`
(`_push_to_agent()`로만 채워짐)뿐이었다. `push_to_org_members()`는 이 실 경로로 개별
push하므로, "실제로 큐에 들어가는가"를 이 파일이 직접 고정한다."""
from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.routers.events import _agent_connections, push_to_org_members


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clean_agent_connections():
    _agent_connections.clear()
    yield
    _agent_connections.clear()


@pytest.mark.anyio
async def test_push_to_org_members_with_explicit_ids_delivers_only_to_those():
    """conversation.working 경로(참가자만) — member_ids 명시 시 그 집합에게만 실제로 도착한다."""
    participant = str(uuid.uuid4())
    non_participant = str(uuid.uuid4())
    q_participant: asyncio.Queue = asyncio.Queue()
    q_non_participant: asyncio.Queue = asyncio.Queue()
    _agent_connections[participant].add(q_participant)
    _agent_connections[non_participant].add(q_non_participant)

    with patch("app.services.event_broker.event_broker.publish", new=AsyncMock()):
        await push_to_org_members(
            str(uuid.uuid4()), "conversation.working", {"conversation_id": "c1"},
            member_ids={participant},
        )

    assert q_participant.get_nowait()["event_type"] == "conversation.working"
    assert q_non_participant.empty()  # 참가자가 아닌 사람에겐 새지 않는다 — 핵심 회귀가드.


@pytest.mark.anyio
async def test_push_to_org_members_none_resolves_org_wide():
    """presence 경로(org 전체) — member_ids 미지정 시 org_members 전체를 스스로 해소해 보낸다."""
    org_id = uuid.uuid4()
    member_a = str(uuid.uuid4())
    member_b = str(uuid.uuid4())
    q_a: asyncio.Queue = asyncio.Queue()
    q_b: asyncio.Queue = asyncio.Queue()
    _agent_connections[member_a].add(q_a)
    _agent_connections[member_b].add(q_b)

    result = type("R", (), {"all": lambda self: [(member_a,), (member_b,)]})()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)

    import contextlib

    @contextlib.asynccontextmanager
    async def _fake_factory():
        yield session

    with patch("app.core.database.async_session_factory", lambda: _fake_factory()), \
         patch("app.services.event_broker.event_broker.publish", new=AsyncMock()):
        await push_to_org_members(str(org_id), "presence", {})

    assert q_a.get_nowait()["event_type"] == "presence"
    assert q_b.get_nowait()["event_type"] == "presence"


@pytest.mark.anyio
async def test_push_to_org_members_empty_member_ids_delivers_to_nobody():
    """member_ids={}(빈 집합, None 아님)이면 org 전체 해소로 폴백하지 않고 정말 아무에게도
    안 간다 — conversation.working의 참가자가 실제로 0명인 엣지케이스(예: 참가자 전원 이탈)."""
    someone = str(uuid.uuid4())
    q = asyncio.Queue()
    _agent_connections[someone].add(q)

    with patch("app.services.event_broker.event_broker.publish", new=AsyncMock()):
        await push_to_org_members(str(uuid.uuid4()), "conversation.working", {}, member_ids=set())

    assert q.empty()


def test_publish_event_and_subscribers_no_longer_exist():
    """회귀가드 — 구 publish_event()/_subscribers가 정말로 삭제됐는지(부활/재도입 감지)."""
    import app.routers.events as events_mod

    assert not hasattr(events_mod, "publish_event")
    assert not hasattr(events_mod, "_subscribers")
