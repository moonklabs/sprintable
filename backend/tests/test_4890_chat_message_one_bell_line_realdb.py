"""story 4890 (UI-7 · PO 11-10) — one chat message, one bell line, one unread.

Measured on dev (web, phone width): an agent wrote 2 messages in a room with a person → the person's bell showed 4 lines («New message» ×2 next to «Agent N: …» ×2) and the badge said 4.
Each message wrote TWO Events for that person: `conversation.message_created` (the row the bell links to the room from) and the `dispatched` one `dispatch_notification` writes for story 1934
(payload.event_type `conversation.message`; the same call also queues the push / personal webhook — that is unchanged). The bell list and the unread count now leave the `dispatched` copy out
and the existing hiding rules (mute · spectator) decide on the message_created row alone, so for every account: lines = messages, unread = messages — and a person the rules hide the message from
(muted · a group they never spoke in) sees none (the copy used to slip past both rules and show a bare «New message»). The rows themselves are still written.
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


async def _world():
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        sender, sender_user = await _make_human_member(s, org.id, project.id)
        reader, reader_user = await _make_human_member(s, org.id, project.id)
    return engine, Session, org.id, project.id, (sender, sender_user), (reader, reader_user)


async def _send(Session, org_id, user_id, conv_id, text):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text


async def _bell(Session, org_id, user_id):
    """(the bell's list rows, the unread count) exactly as the web asks for them"""
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


def _chat_lines(rows):
    """the bell lines that are chat messages: the message_created row, or the dispatched copy"""
    return [r for r in rows if r["event_type"] == "conversation.message_created"
            or (r["event_type"] == "dispatched" and (r.get("payload") or {}).get("event_type") == "conversation.message")]


async def _stored_kinds(Session, member_id):
    """what is WRITTEN for the person (the rows stay — only the bell's read leaves the copy out)"""
    from sqlalchemy import select

    from app.models.event import Event

    async with Session() as s:
        evs = (await s.execute(select(Event.event_type, Event.payload).where(Event.recipient_id == member_id))).all()
    return sorted(("dispatched/conversation.message" if t == "dispatched" and (p or {}).get("event_type") == "conversation.message" else t) for t, p in evs)


async def test_a_dm_message_is_one_line_and_one_unread_each_and_both_rows_are_still_written():
    engine, Session, org_id, project_id, (sender, sender_user), (reader, reader_user) = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="dm")
        for text in ("one", "two"):
            await _send(Session, org_id, sender_user, conv_id, text)
        rows, unread = await _bell(Session, org_id, reader_user)
        lines = _chat_lines(rows)
        assert [r["event_type"] for r in lines] == ["conversation.message_created"] * 2, lines  # before: 4 lines (+ two «New message» copies)
        assert unread == 2, unread  # before: 4
        stored = await _stored_kinds(Session, reader)
        assert stored.count("conversation.message_created") == 2 and stored.count("dispatched/conversation.message") == 2, stored
    finally:
        await engine.dispose()


async def test_a_group_the_person_has_spoken_in_shows_one_line_per_message():
    engine, Session, org_id, project_id, (sender, sender_user), (reader, reader_user) = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="group")
        await _send(Session, org_id, reader_user, conv_id, "I was here")  # the carve-out: spoke → shown
        for text in ("one", "two", "three"):
            await _send(Session, org_id, sender_user, conv_id, text)
        rows, unread = await _bell(Session, org_id, reader_user)
        assert [r["event_type"] for r in _chat_lines(rows)] == ["conversation.message_created"] * 3, _chat_lines(rows)
        assert unread == 3, unread
    finally:
        await engine.dispose()


async def test_a_group_the_person_never_spoke_in_shows_none_not_a_bare_new_message():
    """The spectator rule hides the message_created row; the dispatched copy used to slip past it (a bare «New message» per message)."""
    engine, Session, org_id, project_id, (sender, sender_user), (reader, reader_user) = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="group")
        for text in ("one", "two"):
            await _send(Session, org_id, sender_user, conv_id, text)
        rows, unread = await _bell(Session, org_id, reader_user)
        assert _chat_lines(rows) == [], _chat_lines(rows)  # before: two dispatched lines
        assert unread == 0, unread  # before: 2
        assert (await _stored_kinds(Session, reader)).count("dispatched/conversation.message") == 2  # still written
    finally:
        await engine.dispose()


async def test_a_muted_conversation_shows_none():
    from sqlalchemy import update
    from sqlalchemy.sql import func

    from app.models.conversation import ConversationParticipant

    engine, Session, org_id, project_id, (sender, sender_user), (reader, reader_user) = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, reader], sender, conv_type="dm")
            await s.execute(update(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == reader,
            ).values(muted_at=func.now()))
            await s.commit()
        for text in ("one", "two"):
            await _send(Session, org_id, sender_user, conv_id, text)
        rows, unread = await _bell(Session, org_id, reader_user)
        assert _chat_lines(rows) == [], _chat_lines(rows)
        assert unread == 0, unread
    finally:
        await engine.dispose()


async def test_other_dispatched_notifications_are_still_on_the_bell():
    """Only the chat message copy leaves: a dispatched notification of any other kind (here a gate alert) is still a line and still counts."""
    from app.services.notification_dispatch import dispatch_notification

    engine, Session, org_id, project_id, _sender, (reader, reader_user) = await _world()
    try:
        gate_id = uuid.uuid4()
        async with Session() as s:
            await dispatch_notification(s, org_id=org_id, event_type="gate.pending_approval", target_member_ids=[reader],
                                        title="결재 대기 중인 게이트가 있어요", reference_type="gate", reference_id=gate_id,
                                        source_project_id=project_id)
            await s.commit()
        rows, unread = await _bell(Session, org_id, reader_user)
        assert [(r["event_type"], (r.get("payload") or {}).get("event_type")) for r in rows if r.get("source_entity_id") == str(gate_id)] == [("dispatched", "gate.pending_approval")], rows
        assert unread == 1, unread
    finally:
        await engine.dispose()
