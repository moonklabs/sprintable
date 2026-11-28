"""story 5043 (C10 · PO 11-28): a send that is sent AGAIN with the token (`client_nonce`) of a message this sender already made in this room is that message — not a second copy.

The 6d measurement of the shared browser's draft saw «two identical messages» after a send whose answer did not arrive; the live walk made it again (the answer was cut on its way back, the person pressed Send once more).
The web made a new token for every call and the server only echoed it. Real PostgreSQL (the partial unique index is what stands for ONE), the HTTP road end to end (ASGI), the harness of test_2889_send_message_references_realdb."""
from __future__ import annotations

import asyncio
import contextlib
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _setup(session):
    """org + project + two humans (A sends, B is the other seat) + two group rooms with both humans."""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.flush()
    users = [User(id=uuid.uuid4(), email=f"{n}-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x") for n in ("a", "b")]
    session.add_all(users)
    await session.flush()
    members = [Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=u.id, name=n) for u, n in zip(users, ("A", "B"))]
    session.add_all(members)
    await session.flush()
    session.add_all([ProjectAccess(project_id=project.id, member_id=m.id, permission="granted", role="member") for m in members])
    await session.flush()
    rooms = []
    for _ in range(2):
        conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", created_by=members[0].id)
        session.add(conv)
        await session.flush()
        session.add_all([ConversationParticipant(conversation_id=conv.id, member_id=m.id) for m in members])
        rooms.append(conv)
    await session.commit()
    return org, users, members, rooms


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _as_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _rows(Session, conv_id, sender_id=None):
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage
    async with Session() as s:
        q = select(ConversationMessage).where(ConversationMessage.conversation_id == conv_id)
        if sender_id is not None:
            q = q.where(ConversationMessage.sender_id == sender_id)
        return list((await s.execute(q)).scalars().all())


async def _post(client, conv_id, content, nonce=None):
    body: dict = {"content": content}
    if nonce is not None:
        body["client_nonce"] = nonce
    return await client.post(f"/api/v2/conversations/{conv_id}/messages", json=body)


@contextlib.asynccontextmanager
async def _world():
    """made INSIDE the test's own event loop (an async fixture lives in another one — «attached to a different loop»): the harness of test_2889 does the same, per test."""
    engine, Session = await _session_factory()
    from app.main import app
    async with Session() as s:
        org, users, members, rooms = await _setup(s)
    client = _client_for(app)
    await _as_human(app, Session, users[0].id, org.id)
    try:
        yield {"app": app, "Session": Session, "client": client, "org": org, "users": users, "members": members, "rooms": rooms}
    finally:
        await client.aclose()
        app.dependency_overrides.clear()
        await engine.dispose()


def with_world(fn):
    async def wrapper():
        async with _world() as w:
            await fn(w)
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


@with_world
async def test_the_same_token_sent_again_is_the_same_message_not_a_second_copy(world):
    """the first answer was lost: the SAME call again → 200, the same id, ONE row in the room."""
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    first = await _post(c, room.id, "the line", nonce="nonce-aaa")
    assert first.status_code == 201, first.text
    again = await _post(c, room.id, "the line", nonce="nonce-aaa")
    assert again.status_code == 200, again.text
    assert again.json()["data"]["id"] == first.json()["data"]["id"]
    assert again.json()["data"]["content"] == "the line"
    rows = await _rows(Session, room.id, me.id)
    assert len(rows) == 1 and rows[0].client_nonce == "nonce-aaa"


@with_world
async def test_two_sends_of_the_same_token_at_the_same_moment_make_ONE_message(world):
    """the index stands for ONE: both calls get the same message; exactly one of them made it (201), the other was answered with it (200)."""
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    for round_ in range(5):                                   # (a race is not one throw of the dice)
        nonce = f"nonce-race-{round_}"
        a, b = await asyncio.gather(_post(c, room.id, f"race {round_}", nonce=nonce), _post(c, room.id, f"race {round_}", nonce=nonce))
        assert sorted([a.status_code, b.status_code]) == [200, 201], (a.text, b.text)
        assert a.json()["data"]["id"] == b.json()["data"]["id"]
    assert len(await _rows(Session, room.id, me.id)) == 5


@with_world
async def test_the_lost_race_road_itself_is_taken_and_answers_with_the_row_that_is_there(world):
    """no luck needed: the early look is made to find nothing (as it would for the call that lost the race), so the flush meets the index — the call undoes itself and answers with the existing message."""
    import app.routers.conversations as conv_router
    monkeypatch = pytest.MonkeyPatch()
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    first = await _post(c, room.id, "made first", nonce="nonce-late")
    assert first.status_code == 201
    real, seen = conv_router._replay_of_nonce, {"n": 0}

    async def _blind_once(*a, **k):
        seen["n"] += 1
        return None if seen["n"] == 1 else await real(*a, **k)

    monkeypatch.setattr(conv_router, "_replay_of_nonce", _blind_once)
    try:
        lost = await _post(c, room.id, "made first", nonce="nonce-late")
    finally:
        monkeypatch.undo()
    assert seen["n"] == 2, "the flush did not meet the index (the second look is the recovery)"
    assert lost.status_code == 200 and lost.json()["data"]["id"] == first.json()["data"]["id"]
    assert len(await _rows(Session, room.id, me.id)) == 1


@with_world
async def test_without_a_token_nothing_changes_two_sends_are_two_messages(world):
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    a = await _post(c, room.id, "same words")
    b = await _post(c, room.id, "same words")
    assert a.status_code == b.status_code == 201 and a.json()["data"]["id"] != b.json()["data"]["id"]
    rows = await _rows(Session, room.id, me.id)
    assert len(rows) == 2 and all(r.client_nonce is None for r in rows)


@with_world
async def test_another_token_is_another_message(world):
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    a = await _post(c, room.id, "same words", nonce="nonce-1")
    b = await _post(c, room.id, "same words", nonce="nonce-2")
    assert a.status_code == b.status_code == 201 and a.json()["data"]["id"] != b.json()["data"]["id"]
    assert len(await _rows(Session, room.id, me.id)) == 2


@with_world
async def test_the_same_token_in_another_room_is_another_message(world):
    c, Session, rooms, me = world["client"], world["Session"], world["rooms"], world["members"][0]
    a = await _post(c, rooms[0].id, "x", nonce="nonce-room")
    b = await _post(c, rooms[1].id, "x", nonce="nonce-room")
    assert a.status_code == b.status_code == 201 and a.json()["data"]["id"] != b.json()["data"]["id"]
    assert len(await _rows(Session, rooms[0].id, me.id)) == 1 and len(await _rows(Session, rooms[1].id, me.id)) == 1


@with_world
async def test_the_same_token_from_ANOTHER_sender_is_its_own_message(world):
    """a token is the sending tab's own: B using A's token neither gets A's message nor is refused."""
    c, Session, room, org, users, members = world["client"], world["Session"], world["rooms"][0], world["org"], world["users"], world["members"]
    a = await _post(c, room.id, "from A", nonce="nonce-shared")
    assert a.status_code == 201
    await _as_human(world["app"], Session, users[1].id, org.id)
    b = await _post(c, room.id, "from B", nonce="nonce-shared")
    assert b.status_code == 201 and b.json()["data"]["id"] != a.json()["data"]["id"]
    assert b.json()["data"]["content"] == "from B"
    assert len(await _rows(Session, room.id)) == 2


@with_world
async def test_a_replay_sends_no_second_event_and_bumps_nothing(world):
    """the first call's effects happened once: events of the room stay what the first call made."""
    from sqlalchemy import func, select
    from app.models.event import Event
    c, Session, room = world["client"], world["Session"], world["rooms"][0]
    first = await _post(c, room.id, "once", nonce="nonce-ev")
    assert first.status_code == 201
    async with Session() as s:
        before = (await s.execute(select(func.count()).select_from(Event))).scalar_one()
    again = await _post(c, room.id, "once", nonce="nonce-ev")
    assert again.status_code == 200
    async with Session() as s:
        after = (await s.execute(select(func.count()).select_from(Event))).scalar_one()
    assert after == before, "a replayed send made events again"


@with_world
async def test_the_index_is_the_partial_unique_one_the_migration_says(world):
    """the schema (the migration's, applied to this database): a nullable column and ONE partial unique index over (room · sender · token) where the token is set."""
    from sqlalchemy import text
    async with world["Session"]() as s:
        col = (await s.execute(text("select data_type, character_maximum_length, is_nullable from information_schema.columns where table_name='conversation_messages' and column_name='client_nonce'"))).one()
        idx = (await s.execute(text("select indexdef from pg_indexes where tablename='conversation_messages' and indexname='uq_conversation_messages_client_nonce'"))).scalar_one()
    assert col == ("character varying", 64, "YES")
    assert "UNIQUE" in idx and "(conversation_id, sender_id, client_nonce)" in idx and "client_nonce IS NOT NULL" in idx
