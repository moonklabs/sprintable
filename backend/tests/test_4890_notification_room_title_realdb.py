"""story 4890 (UI-7 P10 · «누가 · 어느 방») — the bell's list names the ROOM of a chat line.

A chat line already says who wrote and what (payload.summary «보낸 이: 미리보기» + sender). The room's name was missing: the list item now carries `target_conversation_title`, resolved for the page in one query.
The name is part of what the room-read gate protects: a row the gate WITHHELD (the caller cannot read that room now — e.g. a person who left it) gets no title, and the title text must not appear anywhere in that response;
a DM has no name of its own (the other person is its name) and a room without a title stays empty; rows that are not chat lines carry none.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

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


TITLE = "ac-room-title-4890"


async def _world(conv_type="group", title=TITLE):
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        sender, sender_user = await _make_human_member(s, org.id, project.id)
        reader, reader_user = await _make_human_member(s, org.id, project.id)
        conv_id = await _make_conversation(s, org.id, project.id, [sender, reader], sender, conv_type=conv_type)
        from sqlalchemy import update

        from app.models.conversation import Conversation

        await s.execute(update(Conversation).where(Conversation.id == conv_id).values(title=title))
        await s.commit()
    return engine, Session, org.id, project.id, conv_id, (sender, sender_user), (reader, reader_user)


async def _send(Session, org_id, user_id, conv_id, text="hello"):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text


async def _bell(Session, org_id, user_id):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.get("/api/v2/event-notifications")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body.get("data", body) if isinstance(body, dict) else body
    return rows, r.text


async def _reader_speaks_first(Session, org_id, reader_user, conv_id):
    """a group's chat lines are hidden from someone who never spoke there (the spectator rule) — the reader says one thing first (their own message is never their own notification)"""
    await _send(Session, org_id, reader_user, conv_id, "I was here")


def _chat(rows):
    return [x for x in rows if x["event_type"] == "conversation.message_created"]


async def test_a_chat_line_of_a_group_room_the_person_can_read_carries_the_room_name():
    engine, Session, org_id, _p, conv_id, (_s, sender_user), (_r, reader_user) = await _world()
    try:
        await _reader_speaks_first(Session, org_id, reader_user, conv_id)
        await _send(Session, org_id, sender_user, conv_id)
        rows, _text = await _bell(Session, org_id, reader_user)
        assert [x["target_conversation_title"] for x in _chat(rows)] == [TITLE], rows
    finally:
        await engine.dispose()


async def test_a_dm_has_no_room_name_and_a_room_without_a_title_stays_empty():
    engine, Session, org_id, _p, conv_id, (_s, sender_user), (_r, reader_user) = await _world(conv_type="dm")
    try:
        await _send(Session, org_id, sender_user, conv_id)
        rows, _text = await _bell(Session, org_id, reader_user)
        assert [x["target_conversation_title"] for x in _chat(rows)] == [None], rows
    finally:
        await engine.dispose()
    engine, Session, org_id, _p, conv_id, (_s, sender_user), (_r, reader_user) = await _world(title="   ")
    try:
        await _reader_speaks_first(Session, org_id, reader_user, conv_id)
        await _send(Session, org_id, sender_user, conv_id)
        rows, _text = await _bell(Session, org_id, reader_user)
        assert [x["target_conversation_title"] for x in _chat(rows)] == [None], rows
    finally:
        await engine.dispose()


async def test_a_person_who_can_no_longer_read_the_room_gets_no_room_name_and_the_name_is_nowhere_in_the_answer():
    """⭐the leak test: the row stays (the bell says that something came), the words are withheld by the room gate, and the room's NAME is withheld with them."""
    from sqlalchemy import delete

    from app.models.conversation import ConversationParticipant

    engine, Session, org_id, _p, conv_id, (_s, sender_user), (reader, reader_user) = await _world()
    try:
        await _reader_speaks_first(Session, org_id, reader_user, conv_id)
        await _send(Session, org_id, sender_user, conv_id, "ac-secret-words-4890")
        rows, text = await _bell(Session, org_id, reader_user)
        assert [x["target_conversation_title"] for x in _chat(rows)] == [TITLE] and "ac-secret-words-4890" in text  # control: while they can read it
        async with Session() as s:
            await s.execute(delete(ConversationParticipant).where(ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == reader))
            await s.commit()
        rows, text = await _bell(Session, org_id, reader_user)
        assert _chat(rows), rows  # the line is still there
        assert all(x["target_conversation_title"] is None for x in rows), rows
        assert TITLE not in text and "ac-secret-words-4890" not in text, text
    finally:
        await engine.dispose()


async def test_a_line_that_is_not_a_chat_line_carries_no_room_name():
    from app.services.notification_dispatch import dispatch_notification

    engine, Session, org_id, project_id, _c, _sender, (reader, reader_user) = await _world()
    try:
        gate_id = uuid.uuid4()
        async with Session() as s:
            await dispatch_notification(s, org_id=org_id, event_type="gate.pending_approval", target_member_ids=[reader], title="gate", reference_type="gate",
                                        reference_id=gate_id, source_project_id=project_id)
            await s.commit()
        rows, _text = await _bell(Session, org_id, reader_user)
        assert rows and all(x["target_conversation_title"] is None for x in rows), rows
    finally:
        await engine.dispose()


async def test_every_room_on_the_page_is_named_in_one_query_not_one_per_line():
    """the titles of a page are resolved together: three rooms → three names, and exactly one statement reads `conversations.title`"""
    from sqlalchemy import event, update

    from app.models.conversation import Conversation

    engine, Session, org_id, project_id, conv_a, (sender, sender_user), (reader, reader_user) = await _world(title="room-A-4890")
    try:
        async with Session() as s:
            conv_b = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="group")
            conv_c = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="group")
            await s.execute(update(Conversation).where(Conversation.id == conv_b).values(title="room-B-4890"))
            await s.execute(update(Conversation).where(Conversation.id == conv_c).values(title="room-C-4890"))
            await s.commit()
        for c in (conv_a, conv_b, conv_c):
            await _reader_speaks_first(Session, org_id, reader_user, c)
            await _send(Session, org_id, sender_user, c)
        seen: list[str] = []

        def _spy(conn, cursor, statement, parameters, context, executemany):
            if "conversations.title" in statement:
                seen.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", _spy)
        try:
            rows, _text = await _bell(Session, org_id, reader_user)
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _spy)
        assert sorted(x["target_conversation_title"] for x in _chat(rows)) == ["room-A-4890", "room-B-4890", "room-C-4890"], rows
        assert len(seen) == 1, seen
    finally:
        await engine.dispose()
