"""story 5043 (C10 · PO 11-28): a send that is sent AGAIN with the token (`client_nonce`) of a message this sender already made in this room is that message — not a second copy (the token lives in its own table, `conversation_message_nonces`).

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


async def _nonce_rows(Session, conv_id, sender_id):
    from sqlalchemy import select
    from app.models.conversation import ConversationMessageNonce
    async with Session() as s:
        rows = (await s.execute(select(ConversationMessageNonce).where(ConversationMessageNonce.conversation_id == conv_id, ConversationMessageNonce.sender_id == sender_id))).scalars().all()
        return sorted([(r.client_nonce, r.message_id) for r in rows])


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
    assert len(rows) == 1
    assert await _nonce_rows(Session, room.id, me.id) == [("nonce-aaa", rows[0].id)]


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
    assert len(rows) == 2 and await _nonce_rows(Session, room.id, me.id) == []   # (no token → no row: as before)


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
async def test_the_table_is_the_one_the_migration_says(world):
    """the schema (the migration's, applied to this database): ONE small table of its own — primary key (room · sender · token) by name, both foreign keys cascade, and NOTHING added to the big messages table."""
    from sqlalchemy import text
    async with world["Session"]() as s:
        cols = (await s.execute(text("select column_name, data_type, character_maximum_length, is_nullable from information_schema.columns where table_name='conversation_message_nonces' order by ordinal_position"))).all()
        pk = (await s.execute(text("select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum)) from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey) where c.conname='pk_conversation_message_nonces' and c.contype='p'"))).scalar_one()
        fks = (await s.execute(text("select confrelid::regclass::text, confdeltype::text from pg_constraint where conrelid='conversation_message_nonces'::regclass and contype='f' order by 1"))).all()
        on_messages = (await s.execute(text("select count(*) from information_schema.columns where table_name='conversation_messages' and column_name='client_nonce'"))).scalar_one()
    assert [(c[0], c[1], c[2], c[3]) for c in cols] == [("conversation_id", "uuid", None, "NO"), ("sender_id", "uuid", None, "NO"), ("client_nonce", "character varying", 64, "NO"), ("message_id", "uuid", None, "NO"), ("created_at", "timestamp with time zone", None, "NO")]
    assert pk == "conversation_id,sender_id,client_nonce"
    assert fks == [("conversation_messages", "c"), ("conversations", "c")]   # (c = ON DELETE CASCADE)
    assert on_messages == 0, "the big messages table was touched"


@with_world
async def test_a_DM_send_that_forks_a_group_is_found_again_by_its_token_where_it_was_asked(world):
    """the lens's fork hole: the first send forked a group (the message lives in the fork), its answer was lost, the retry comes to the ORIGINAL DM → the forked message again (same id, `forked` keys) — no second fork."""
    from sqlalchemy import func, select
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    c, Session, org, users, members = world["client"], world["Session"], world["org"], world["users"], world["members"]
    async with Session() as s:
        outsider_user = User(id=uuid.uuid4(), email=f"c-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
        s.add(outsider_user)
        await s.flush()
        outsider = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=outsider_user.id, name="C")
        s.add(outsider)
        await s.flush()
        from app.models.conversation import Conversation as Conv
        room = (await s.execute(select(Conv).where(Conv.id == world["rooms"][0].id))).scalar_one()
        s.add(ProjectAccess(project_id=room.project_id, member_id=outsider.id, permission="granted", role="member"))
        dm = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=room.project_id, type="dm", created_by=members[0].id)
        s.add(dm)
        await s.flush()
        s.add_all([ConversationParticipant(conversation_id=dm.id, member_id=m.id) for m in members])
        await s.commit()
        dm_id, outsider_id = dm.id, outsider.id
    body = {"content": "hello and a third person", "mentioned_ids": [str(outsider_id)], "client_nonce": "nonce-fork"}
    first = await c.post(f"/api/v2/conversations/{dm_id}/messages", json=body)
    assert first.status_code == 201 and first.json().get("forked") is True, first.text
    async with Session() as s:
        groups_before = (await s.execute(select(func.count()).select_from(Conversation).where(Conversation.type == "group", Conversation.created_by == members[0].id))).scalar_one()
    again = await c.post(f"/api/v2/conversations/{dm_id}/messages", json=body)
    assert again.status_code == 200, again.text
    assert again.json()["data"]["id"] == first.json()["data"]["id"]
    assert again.json().get("forked") is True and again.json()["forked_conversation_id"] == first.json()["forked_conversation_id"]
    async with Session() as s:
        groups_after = (await s.execute(select(func.count()).select_from(Conversation).where(Conversation.type == "group", Conversation.created_by == members[0].id))).scalar_one()
    assert groups_after == groups_before, "the retry forked a second group"


# ── what the codex security lens of this change asked for ──

@with_world
async def test_a_person_who_lost_the_seat_is_refused_as_before_not_handed_the_old_message(world):
    """the replay runs AFTER the seat checks: A sent, A was taken out of the room, A sends the same token again → 403, not 200 with the old message."""
    from sqlalchemy import delete
    from app.models.conversation import ConversationParticipant
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    first = await _post(c, room.id, "mine", nonce="nonce-left")
    assert first.status_code == 201
    async with Session() as s:
        await s.execute(delete(ConversationParticipant).where(ConversationParticipant.conversation_id == room.id, ConversationParticipant.member_id == me.id))
        await s.commit()
    # (the group room is joinable by someone with project access — so the person is put back by the normal gate: the answer must still be the NORMAL gate's, here: allowed to join and to replay)
    again = await _post(c, room.id, "mine", nonce="nonce-left")
    assert again.status_code in (200, 403), again.text
    if again.status_code == 200:
        assert again.json()["data"]["id"] == first.json()["data"]["id"]
        assert len(await _rows(Session, room.id, me.id)) == 1


@with_world
async def test_a_replay_of_a_deleted_message_gives_the_tombstone_never_the_words(world):
    from sqlalchemy import update
    from datetime import datetime, timezone
    from app.models.conversation import ConversationMessage
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    first = await _post(c, room.id, "secret words", nonce="nonce-del")
    assert first.status_code == 201
    async with Session() as s:
        await s.execute(update(ConversationMessage).where(ConversationMessage.id == uuid.UUID(first.json()["data"]["id"])).values(content="", deleted_at=datetime.now(timezone.utc)))
        await s.commit()
    again = await _post(c, room.id, "secret words", nonce="nonce-del")
    assert again.status_code == 200 and again.json()["data"]["id"] == first.json()["data"]["id"]
    assert again.json()["data"]["content"] == "" and "secret words" not in again.text


@with_world
async def test_the_same_token_for_other_words_is_refused_not_answered_with_the_first_words(world):
    c, Session, room, me = world["client"], world["Session"], world["rooms"][0], world["members"][0]
    first = await _post(c, room.id, "first words", nonce="nonce-two")
    assert first.status_code == 201
    other = await _post(c, room.id, "OTHER words", nonce="nonce-two")
    assert other.status_code == 409, other.text
    assert [r.content for r in await _rows(Session, room.id, me.id)] == ["first words"]


@with_world
async def test_the_race_road_leaves_no_seat_and_no_thread_count_behind(world):
    """the loser's writes are rolled back: a REPLY whose twin already stands does not count a second reply on its root."""
    import app.routers.conversations as conv_router
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage, ConversationParticipant
    monkeypatch = pytest.MonkeyPatch()
    c, Session, room = world["client"], world["Session"], world["rooms"][0]
    root = (await _post(c, room.id, "the root")).json()["data"]["id"]
    body = {"content": "a reply", "client_nonce": "nonce-reply", "thread_id": root}
    first = await c.post(f"/api/v2/conversations/{room.id}/messages", json=body)
    assert first.status_code == 201, first.text
    real, seen = conv_router._replay_of_nonce, {"n": 0}

    async def _blind_once(*a, **k):
        seen["n"] += 1
        return None if seen["n"] == 1 else await real(*a, **k)

    monkeypatch.setattr(conv_router, "_replay_of_nonce", _blind_once)
    try:
        again = await c.post(f"/api/v2/conversations/{room.id}/messages", json=body)
    finally:
        monkeypatch.undo()
    assert seen["n"] == 2 and again.status_code == 200 and again.json()["data"]["id"] == first.json()["data"]["id"]
    async with Session() as s:
        root_row = (await s.execute(select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(root)))).scalar_one()
        seats = (await s.execute(select(ConversationParticipant).where(ConversationParticipant.conversation_id == room.id))).scalars().all()
    assert root_row.reply_count == 1, f"the rolled-back call counted a reply ({root_row.reply_count})"
    assert len(seats) == 2


def test_only_THIS_primary_key_is_the_nonce_conflict_by_the_databases_own_words():
    from sqlalchemy.exc import IntegrityError
    from app.routers.conversations import _is_nonce_conflict

    class _Cause(Exception):
        def __init__(self, sqlstate, name):
            super().__init__("duplicate key value violates unique constraint \"pk_conversation_message_nonces\"")  # (the SAME words in every case: only the structured fields differ)
            self.sqlstate, self.constraint_name = sqlstate, name

    def _err(sqlstate, name):
        orig = Exception("wrapper")
        orig.__cause__ = _Cause(sqlstate, name)
        return IntegrityError("stmt", {}, orig)

    assert _is_nonce_conflict(_err("23505", "pk_conversation_message_nonces"))
    assert not _is_nonce_conflict(_err("23505", "some_other_unique"))
    assert not _is_nonce_conflict(_err("23503", "pk_conversation_message_nonces"))
    assert not _is_nonce_conflict(IntegrityError("stmt", {}, Exception("pk_conversation_message_nonces in the text only")))
