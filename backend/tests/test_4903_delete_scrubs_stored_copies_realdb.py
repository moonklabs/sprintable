"""story #4903 AC1 — deleting a message also removes the words from the copies the server stored of it.

Found on dev (two throwaway accounts, 11-12): the delete tombstones the message row (`content = ""`) and the list / single / messages
reads are clean — but two stored copies of the same words were left behind:
- the **notification row** of a mention (`notifications.body` = a preview made at send time — it has no link to the message, only
  `reference_id = conversation_id`): the mentioned person's bell kept showing the deleted words (every read, for as long as the row lives);
- the **event row** (`events.payload` — `content`, `summary`, `attachments` copied at send time): a new stream connection backfills the
  last few events (pending + delivered in the last 300 s), so a reload put the deleted words back into the room list's row.

Proved here against a real PG, through the real routes (send with a mention → delete): the same rows, read after the delete, carry none of
the words — for every recipient — and a message that was NOT deleted keeps its own copies (nothing is over-scrubbed).
"""
from __future__ import annotations

import json
import os
import uuid

import pytest
from sqlalchemy import select

from tests.test_2054_gate_inbox import _client_for as _bell_client_for, _setup_app as _setup_bell_app
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

WORDS = "지울 마지막 글 — 4903 scrub-me"
KEEP = "남길 글 — 4903 keep-me"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _as(app, Session, user_id, org_id, fn):
    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def _room(Session):
    """one org · one project · a room of three people: A (sends · deletes), B and C (both mentioned)"""
    async with Session() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        a_id, a_user = await _make_human_member(session, org.id, project.id)
        b_id, b_user = await _make_human_member(session, org.id, project.id)
        c_id, c_user = await _make_human_member(session, org.id, project.id)
        conv_id = await _make_conversation(session, org.id, project.id, [a_id, b_id, c_id], a_id)
    return org.id, conv_id, (a_id, a_user), (b_id, b_user), (c_id, c_user)


async def _send(app, Session, user, org_id, conv_id, text, mention_ids):
    r = await _as(app, Session, user, org_id,
                  lambda c: c.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text, "mentioned_ids": [str(m) for m in mention_ids]}))
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


async def _event_payloads(Session, message_id):
    from app.models.event import Event

    async with Session() as session:
        rows = (await session.execute(
            select(Event).where(Event.source_entity_type == "conversation_message", Event.source_entity_id == uuid.UUID(message_id))
        )).scalars().all()
        return [json.dumps(e.payload or {}, ensure_ascii=False) for e in rows]


async def _notification_rows(Session, conv_id):
    from app.models.notification import Notification

    async with Session() as session:
        rows = (await session.execute(select(Notification).where(Notification.reference_id == conv_id))).scalars().all()
        return [(n.user_id, n.body, json.dumps(n.event or {}, ensure_ascii=False), n.title) for n in rows]


async def test_deleting_a_message_scrubs_its_notification_rows_and_event_rows_for_every_recipient():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (c_id, c_user) = await _room(Session)
        from app.main import app

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id, c_id])

        # BEFORE the delete: the stored copies exist (so the assertions after it are not vacuous)
        notes = await _notification_rows(Session, conv_id)
        assert [n for n in notes if n[1] and "scrub-me" in n[1]], f"two mention rows carry the words before the delete: {notes}"
        assert len([n for n in notes if n[1] and "scrub-me" in n[1]]) == 2, notes
        events = await _event_payloads(Session, msg_id)
        assert events and all("scrub-me" in e for e in events), "the event rows carry the words before the delete"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text

        # AFTER: nobody's notification row · no event row of that message carries the words
        notes = await _notification_rows(Session, conv_id)
        for user_id, body, event_json, title in notes:
            assert "scrub-me" not in (body or ""), f"a notification row still carries the deleted words: {(user_id, body)}"
            assert "scrub-me" not in event_json, f"a notification row's event still carries the deleted words: {event_json}"
            assert "scrub-me" not in (title or ""), title
        events = await _event_payloads(Session, msg_id)
        assert events, "the event rows are kept (the bell / backfill still know a message existed) — only the words are gone"
        for e in events:
            assert "scrub-me" not in e, f"an event row still carries the deleted words: {e}"

        # and over the API a recipient reads: the bell line of B (what the person sees)
        await _setup_bell_app(app, Session, org_id, b_user)
        try:
            bell = await _bell_client_for(app).get("/api/v2/notifications")
        finally:
            app.dependency_overrides.clear()
        assert bell.status_code == 200, bell.text
        assert any(str(conv_id) == str(row.get("reference_id")) for row in bell.json()["data"]), "B's bell still has the line (the row is kept)"
        assert "scrub-me" not in bell.text, "B's bell must not show the deleted words"
    finally:
        await engine.dispose()


async def test_a_message_that_was_not_deleted_keeps_its_own_copies():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app

        gone = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        kept = await _send(app, Session, a_user, org_id, conv_id, KEEP, [b_id])
        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{gone}"))
        assert d.status_code == 200, d.text

        notes = await _notification_rows(Session, conv_id)
        assert [n for n in notes if n[1] and "keep-me" in n[1]], f"the kept message's notification row is untouched: {notes}"
        assert not [n for n in notes if n[1] and "scrub-me" in n[1]], notes
        kept_events = await _event_payloads(Session, kept)
        assert kept_events and all("keep-me" in e for e in kept_events), "the kept message's event rows are untouched"
    finally:
        await engine.dispose()


async def test_the_same_words_in_another_room_are_not_touched():
    """no over-scrub across rooms: the notification match is the deleted message's own room (reference_id) and moment"""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.models.conversation import Conversation

        async with Session() as session:
            project_id = (await session.execute(select(Conversation.project_id).where(Conversation.id == conv_id))).scalar_one()
            other_conv = await _make_conversation(session, org_id, project_id, [a_id, b_id], a_id)
        from app.main import app

        gone = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        await _send(app, Session, a_user, org_id, other_conv, WORDS, [b_id])  # the same words, another room
        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{gone}"))
        assert d.status_code == 200, d.text

        assert not [n for n in await _notification_rows(Session, conv_id) if n[1] and "scrub-me" in n[1]]
        other = [n for n in await _notification_rows(Session, other_conv) if n[1] and "scrub-me" in n[1]]
        assert other, "the other room's message was not deleted: its notification row keeps its words"
    finally:
        await engine.dispose()
