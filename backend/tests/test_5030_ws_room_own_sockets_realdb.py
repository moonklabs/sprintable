"""story 5030 (C0) — the websocket room of an agent: who is «the agent's own socket». Real PG, the real `ws_chat._broadcast`, fake sockets.

A room is per agent (`room_key` = the agent's member id) but its sockets are the agent's own AND the people who may read the conversation. A line that does not call the agent (a group room
delivers an agent only the words that call it) must not reach a socket OWNED BY THE AGENT; the people in the room still read it. The first version skipped «sockets connected with an agent key»,
which is the wrong test in both directions (codex, 5030 second look):

  · an agent that connected with a LOGIN (no key) is still the agent's own socket → skipped            (test_an_agent_connected_with_a_login_is_still_the_rooms_own_socket)
  · a PERSON that connected with an `sk_live_` key is not the agent's socket → still reads the line   (test_a_person_connected_with_an_agent_key_still_reads_the_line)
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _room_world():
    """a group room of one agent (A) and one person (H); returns what the sockets are made from."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as s:
        org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.commit()
        project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
        s.add(project)
        await s.commit()
        uid = uuid.uuid4()
        s.add(User(id=uid, email=f"h-{uid.hex[:8]}@test.com", hashed_password="x"))
        await s.commit()
        s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uid, role="member"))
        # the agent has a login of its own (a user and a seat in the organization) — that is how an agent connects WITHOUT a key
        agent_uid = uuid.uuid4()
        s.add(User(id=agent_uid, email=f"a-{agent_uid.hex[:8]}@test.com", hashed_password="x"))
        await s.commit()
        s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=agent_uid, role="member"))
        person = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=uid, name="H")
        agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", user_id=agent_uid, name="A", is_active=True)
        s.add_all([person, agent])
        await s.commit()
        for m in (person, agent):
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member"))
        await s.commit()
        room = Conversation(id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", title="room", created_by=person.id)
        s.add(room)
        await s.flush()
        for m in (person, agent):
            s.add(ConversationParticipant(conversation_id=room.id, member_id=m.id))
        await s.commit()
    return engine, org.id, room.id, person, agent


def _socket():
    ws = MagicMock()
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()
    return ws


async def _broadcast_into_room(org_id, room_id, agent_id, sockets: dict, *, skip_own_sockets: bool):
    from app.routers import ws_chat

    key = str(agent_id)
    with patch.dict(ws_chat._rooms, {key: set(sockets)}, clear=False), patch.dict(ws_chat._idents, sockets, clear=False):
        await ws_chat._broadcast(key, "the line", conversation_id=room_id, skip_own_sockets=skip_own_sockets)


@pytest.mark.anyio
async def test_an_agent_connected_with_a_login_is_still_the_rooms_own_socket():
    from app.routers.ws_chat import _SocketIdent

    engine, org_id, room_id, person, agent = await _room_world()
    try:
        # the agent holds the socket with a login, not a key (`via_agent_key` False) — still its own: owner = the room's agent
        own = _socket()
        sockets = {own: _SocketIdent(member_id=agent.id, access_user_id=agent.user_id, org_id=org_id, via_agent_key=False)}
        # control: without the skip the agent's own socket is sent the line (so the skip below proves something)
        await _broadcast_into_room(org_id, room_id, agent.id, sockets, skip_own_sockets=False)
        own.send_text.assert_awaited_once()
        own.send_text.reset_mock()

        await _broadcast_into_room(org_id, room_id, agent.id, sockets, skip_own_sockets=True)
        own.send_text.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_connected_with_an_agent_key_still_reads_the_line():
    from app.routers.ws_chat import _SocketIdent

    engine, org_id, room_id, person, agent = await _room_world()
    try:
        # a PERSON connected with an `sk_live_` key (`via_agent_key` True, owner = the person) and the agent's own socket (key too)
        key_person, own = _socket(), _socket()
        sockets = {
            key_person: _SocketIdent(member_id=person.id, access_user_id=person.user_id, org_id=org_id, via_agent_key=True),
            own: _SocketIdent(member_id=agent.id, access_user_id=agent.id, org_id=org_id, via_agent_key=True),
        }
        await _broadcast_into_room(org_id, room_id, agent.id, sockets, skip_own_sockets=True)
        key_person.send_text.assert_awaited_once()   # the person reads the line the agent was not called by
        own.send_text.assert_not_awaited()           # the agent's own socket does not
    finally:
        await engine.dispose()
