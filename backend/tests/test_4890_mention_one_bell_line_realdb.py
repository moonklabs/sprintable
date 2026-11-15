"""story 4890 (UI-7 · PO 11-10) — a message that MENTIONS a person is one bell line and one unread for them.

Measured on dev: one agent message that mentioned the person made TWO lines (`conversation:mention` + `conversation.message_created`) and unread 2. The mention row is the specific one (the person asked for it) and stays;
the room's message_created row for the SAME message and the SAME person leaves the bell's read (list and count). Everyone else in the room keeps their one message_created line; both rows are still written; mute still hides
both (mute is per room and decides first).
"""
from __future__ import annotations

import os

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


async def _world(conv_type="group"):
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        sender, sender_user = await _make_human_member(s, org.id, project.id)
        reader, reader_user = await _make_human_member(s, org.id, project.id)
        other, other_user = await _make_human_member(s, org.id, project.id)
        conv_id = await _make_conversation(s, org.id, project.id, [sender, reader, other], sender, conv_type=conv_type)
    return engine, Session, org.id, conv_id, (sender, sender_user), (reader, reader_user), (other, other_user)


async def _send(Session, org_id, user_id, conv_id, text, mentioned=()):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text, "mentioned_ids": [str(m) for m in mentioned]})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text


async def _bell(Session, org_id, user_id):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            items = await client.get("/api/v2/event-notifications")
            count = await client.get("/api/v2/event-notifications/unread-count")
    finally:
        app.dependency_overrides.clear()
    assert items.status_code == 200 and count.status_code == 200, (items.text, count.text)
    body = items.json()
    rows = body.get("data", body) if isinstance(body, dict) else body
    c = count.json()
    return rows, (c.get("data") or c)["count"]


def _kinds(rows, since=()):
    """the chat lines of the list (not the ones already there before: `since` = their ids)"""
    return sorted(r["event_type"] for r in rows if r["event_type"] in ("conversation.message_created", "conversation:mention") and r["id"] not in since)


def _ids(rows):
    return {r["id"] for r in rows}


async def _speak_first(Session, org_id, user_id, conv_id):
    await _send(Session, org_id, user_id, conv_id, "I was here")  # a group's lines are hidden from someone who never spoke (the spectator rule)


async def test_a_message_that_mentions_the_person_is_one_line_and_one_unread_for_them_and_a_message_that_does_not_is_its_own_line():
    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), (_o, other_user) = await _world()
    try:
        await _speak_first(Session, org_id, reader_user, conv_id)
        await _speak_first(Session, org_id, other_user, conv_id)
        before, unread0 = await _bell(Session, org_id, reader_user)  # the other's «I was here» is already a line (not a mention)
        seen = _ids(before)
        await _send(Session, org_id, sender_user, conv_id, "hey you", mentioned=[reader])
        rows, unread = await _bell(Session, org_id, reader_user)
        # reverted (the message_created row of a mentioned message back in the read) → two lines · unread +2
        assert _kinds(rows, seen) == ["conversation:mention"] and unread == unread0 + 1, rows
        await _send(Session, org_id, sender_user, conv_id, "and everybody")
        rows, unread = await _bell(Session, org_id, reader_user)
        assert _kinds(rows, seen) == ["conversation.message_created", "conversation:mention"] and unread == unread0 + 2, rows
    finally:
        await engine.dispose()


async def test_a_person_who_was_not_mentioned_keeps_the_rooms_line_for_that_message():
    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), (_o, other_user) = await _world()
    try:
        await _speak_first(Session, org_id, reader_user, conv_id)
        await _speak_first(Session, org_id, other_user, conv_id)
        before, unread0 = await _bell(Session, org_id, other_user)
        seen = _ids(before)
        await _send(Session, org_id, sender_user, conv_id, "hey you", mentioned=[reader])
        rows, unread = await _bell(Session, org_id, other_user)
        assert _kinds(rows, seen) == ["conversation.message_created"] and unread == unread0 + 1, rows
    finally:
        await engine.dispose()


async def test_both_rows_are_still_written_for_the_mentioned_person():
    from sqlalchemy import select

    from app.models.event import Event

    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), _o = await _world()
    try:
        await _speak_first(Session, org_id, reader_user, conv_id)
        await _send(Session, org_id, sender_user, conv_id, "hey you", mentioned=[reader])
        async with Session() as s:
            kinds = sorted(t for (t,) in (await s.execute(select(Event.event_type).where(Event.recipient_id == reader, Event.event_type.in_(["conversation.message_created", "conversation:mention"])))).all())
        assert kinds == ["conversation.message_created", "conversation:mention"]
    finally:
        await engine.dispose()


async def test_a_muted_room_hides_both_rows_of_a_mentioning_message():
    from sqlalchemy import update

    from app.models.conversation import ConversationParticipant

    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), _o = await _world()
    try:
        await _speak_first(Session, org_id, reader_user, conv_id)
        async with Session() as s:
            from datetime import datetime, timezone

            await s.execute(update(ConversationParticipant).where(ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == reader).values(muted_at=datetime.now(timezone.utc)))
            await s.commit()
        await _send(Session, org_id, sender_user, conv_id, "hey you", mentioned=[reader])
        rows, unread = await _bell(Session, org_id, reader_user)
        assert _kinds(rows) == [] and unread == 0, rows
    finally:
        await engine.dispose()


async def test_a_dm_message_that_mentions_the_person_is_one_line_too():
    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), _o = await _world(conv_type="dm")
    try:
        await _send(Session, org_id, sender_user, conv_id, "hey you", mentioned=[reader])
        rows, unread = await _bell(Session, org_id, reader_user)
        assert _kinds(rows) == ["conversation:mention"] and unread == 1, rows
    finally:
        await engine.dispose()


async def test_a_mention_row_of_another_organization_for_the_same_message_id_hides_nothing():
    """the lookup is scoped to the row's own organization: a stand-in mention row in ANOTHER org (same recipient · same source id) must not take the line away"""
    import uuid

    from app.models.event import Event

    engine, Session, org_id, conv_id, (_s, sender_user), (reader, reader_user), (_o, other_user) = await _world()
    try:
        await _speak_first(Session, org_id, reader_user, conv_id)
        await _speak_first(Session, org_id, other_user, conv_id)
        before, unread0 = await _bell(Session, org_id, reader_user)
        seen = _ids(before)
        await _send(Session, org_id, sender_user, conv_id, "plain, no mention")
        rows, unread = await _bell(Session, org_id, reader_user)
        line = next(r for r in rows if r["id"] not in seen and r["event_type"] == "conversation.message_created")
        async with Session() as s:
            org2 = await _make_org(s)
            s.add(Event(project_id=None, org_id=org2.id, event_type="conversation:mention", source_entity_type="conversation_message", source_entity_id=uuid.UUID(str(line["source_entity_id"])),
                        sender_id=None, recipient_id=reader, recipient_type="human", payload={"summary": "x"}, status="delivered"))
            await s.commit()
        rows, unread = await _bell(Session, org_id, reader_user)
        # reverted (the lookup not scoped by organization) → the line is gone
        assert _kinds(rows, seen) == ["conversation.message_created"] and unread == unread0 + 1, rows
    finally:
        await engine.dispose()


async def test_only_a_human_recipient_has_the_rooms_row_hidden_an_agent_keeps_both_rows():
    """the dedupe is for the bell a PERSON reads: the same predicate for an agent recipient (an agent reads its events through the same endpoints) hides nothing"""
    import uuid

    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.event_notifications import _is_hidden_notification

    engine, Session, org_id, conv_id, (_s, _su), (reader, _ru), (other, _ou) = await _world()
    try:
        src = uuid.uuid4()
        async with Session() as s:
            ids = {}
            for who, kind in ((reader, "human"), (other, "agent")):
                for et in ("conversation.message_created", "conversation:mention"):
                    ev = Event(project_id=None, org_id=org_id, event_type=et, source_entity_type="conversation_message", source_entity_id=src, sender_id=None, recipient_id=who, recipient_type=kind,
                               payload={"summary": "x"}, status="delivered")
                    s.add(ev)
                    await s.flush()
                    ids[(kind, et)] = ev.id
            await s.commit()
            hidden_for_human = set((await s.execute(select(Event.id).where(Event.recipient_id == reader, _is_hidden_notification(reader)))).scalars())
            hidden_for_agent = set((await s.execute(select(Event.id).where(Event.recipient_id == other, _is_hidden_notification(other)))).scalars())
        assert ids[("human", "conversation.message_created")] in hidden_for_human and ids[("human", "conversation:mention")] not in hidden_for_human
        assert hidden_for_agent == set()  # reverted (no human-only term) → the agent's message_created row is hidden
    finally:
        await engine.dispose()
