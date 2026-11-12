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


async def _make_rows_old_form(Session, conv_ids):
    """make the notification rows of these rooms look like the ones made before #4903: the card without the message id"""
    from app.models.notification import Notification

    async with Session() as session:
        for row in (await session.execute(select(Notification).where(Notification.reference_id.in_(conv_ids)))).scalars().all():
            row.event = {"sender_name": row.event["sender_name"]} if row.event else None
        await session.commit()


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
        assert all(msg_id in n[2] for n in notes if n[1] and "scrub-me" in n[1]), f"a notification row made now names its message (event.message_id): {notes}"
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
        await _make_rows_old_form(Session, [conv_id, other_conv])  # the old-form rows are matched by room · moment · words: the room condition is what keeps the other room safe
        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{gone}"))
        assert d.status_code == 200, d.text

        assert not [n for n in await _notification_rows(Session, conv_id) if n[1] and "scrub-me" in n[1]]
        other = [n for n in await _notification_rows(Session, other_conv) if n[1] and "scrub-me" in n[1]]
        assert other, "the other room's message was not deleted: its notification row keeps its words"
    finally:
        await engine.dispose()


async def test_the_same_short_words_twice_in_a_minute_deleting_one_leaves_the_others_notification():
    """the room says «ok» twice within a minute (two messages, two notification rows with the same preview): deleting ONE scrubs only ITS row —
    the other message's notification is somebody else's live notification and stays (PO review: a match by words + time would blank it too)."""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app

        first = await _send(app, Session, a_user, org_id, conv_id, "ok", [b_id])
        second = await _send(app, Session, a_user, org_id, conv_id, "ok", [b_id])
        before = await _notification_rows(Session, conv_id)
        n_first = len([n for n in before if first in n[2]])
        n_second = len([n for n in before if second in n[2]])
        assert n_first >= 1 and n_second >= 1 and all(n[1] == "ok" for n in before), f"each message has its own rows, all with the same preview: {before}"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{first}"))
        assert d.status_code == 200, d.text

        after = await _notification_rows(Session, conv_id)
        kept = [n for n in after if n[1] == "ok"]
        assert len(kept) == n_second and all(second in n[2] for n in kept), f"the SECOND message's rows keep their words, every one: {after}"
        assert len([n for n in after if n[1] is None]) == n_first, f"and the first message's rows lost them: {after}"
    finally:
        await engine.dispose()


async def test_a_notification_row_made_before_the_id_existed_is_still_scrubbed_by_room_moment_and_words():
    """a row without `event.message_id` (made before #4903) has only the old link: the room, the moment and the preview — and a live message's
    old-form rows in the same room and minute (other words) are left alone"""
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        await _send(app, Session, a_user, org_id, conv_id, KEEP, [b_id])
        await _make_rows_old_form(Session, [conv_id])
        assert not [n for n in await _notification_rows(Session, conv_id) if msg_id in n[2]], "no row names its message now"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        rows = await _notification_rows(Session, conv_id)
        assert not [n for n in rows if n[1] and "scrub-me" in n[1]], "the old-form rows of the deleted message are scrubbed too"
        assert [n for n in rows if n[1] and "keep-me" in n[1]], f"the live message's old-form rows keep their words: {rows}"
    finally:
        await engine.dispose()


# ── the other stored copies codex found (round 1): bell events · activity rows · delivery jobs · signed image URLs · the cards on a tombstone ────────────


async def _rows(Session, model, *where):
    async with Session() as session:
        return (await session.execute(select(model).where(*where))).scalars().all()


async def test_the_bell_event_rows_the_activity_rows_and_the_pending_delivery_jobs_lose_the_words_too():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (c_id, _c_user) = await _room(Session)
        from app.main import app
        from app.models.activity_event import ActivityEvent
        from app.models.delivery_job import DeliveryJob
        from app.models.event import Event

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])

        def bells(rows):
            return [e for e in rows if e.event_type == "dispatched" and e.source_entity_type == "conversation"]

        events_before = await _rows(Session, Event, Event.source_entity_id == conv_id)
        bell_before = [e for e in bells(events_before) if "scrub-me" in json.dumps(e.payload or {}, ensure_ascii=False)]
        assert bell_before, "a bell (dispatched) event row carries the words before the delete — otherwise this test proves nothing"
        assert all((e.payload or {}).get("message_id") == msg_id for e in bell_before), "…and names its message"
        def this_room(jobs):  # the outbox is shared by every test that ran in this database: this room's jobs only
            return [j for j in jobs if (j.payload or {}).get("reference_id") == str(conv_id)]

        jobs_before = [j for j in this_room(await _rows(Session, DeliveryJob)) if "scrub-me" in json.dumps(j.payload or {}, ensure_ascii=False)]
        assert jobs_before and all(j.payload.get("message_id") == msg_id for j in jobs_before), "a delivery job carries the words and names its message"
        acts_before = [a for a in await _rows(Session, ActivityEvent, ActivityEvent.org_id == org_id) if "scrub-me" in json.dumps(a.payload or {}, ensure_ascii=False)]
        assert acts_before, "the activity stream copied the words before the delete"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text

        for e in await _rows(Session, Event, Event.source_entity_id.in_([conv_id, uuid.UUID(msg_id)])):
            assert "scrub-me" not in json.dumps(e.payload or {}, ensure_ascii=False), f"an event row still carries the words: {e.event_type} {e.payload}"
        for j in this_room(await _rows(Session, DeliveryJob)):
            assert "scrub-me" not in json.dumps(j.payload or {}, ensure_ascii=False), f"a delivery job still carries the words: {j.payload}"
        for a in await _rows(Session, ActivityEvent, ActivityEvent.org_id == org_id):
            assert "scrub-me" not in json.dumps(a.payload or {}, ensure_ascii=False), f"an activity row still carries the words: {a.payload}"
    finally:
        await engine.dispose()


async def test_signed_image_urls_in_a_stored_event_payload_go_too():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app
        from app.models.event import Event

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        async with Session() as session:  # the dispatch adds signed URLs when a message carries images: put one in the way it is stored
            for e in (await session.execute(select(Event).where(Event.source_entity_id == uuid.UUID(msg_id)))).scalars().all():
                e.payload = {**(e.payload or {}), "images": ["https://signed.example/private.png?sig=abc"]}
            await session.commit()
        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        events = await _event_payloads(Session, msg_id)
        assert events and all("signed.example" not in e for e in events), events
    finally:
        await engine.dispose()


async def test_a_tombstone_serves_no_card_the_cards_in_msg_metadata_carry_words_of_their_own():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app
        from app.models.conversation import ConversationMessage

        msg_id = await _send(app, Session, a_user, org_id, conv_id, "card carrier", [])
        async with Session() as session:
            row = (await session.execute(select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(msg_id)))).scalar_one()
            row.msg_metadata = {"event": {"event_key": "probe.k", "payload": {"summary": "card-words scrub-me"}}}
            await session.commit()

        before = await _as(app, Session, b_user, org_id, lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert before.status_code == 200 and "card-words" in before.text, "the card is served before the delete — otherwise this test proves nothing"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        after = await _as(app, Session, b_user, org_id, lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert after.status_code == 200, after.text
        assert "card-words" not in after.text, "a deleted message's card is not served"
        assert after.json().get("event") is None and after.json().get("deleted_at"), after.json()  # the key stays (the shape is the same), empty
        listed = await _as(app, Session, b_user, org_id, lambda c: c.get(f"/api/v2/conversations/{conv_id}/messages"))
        assert listed.status_code == 200 and "card-words" not in listed.text, "…nor in the list read"
    finally:
        await engine.dispose()


async def test_a_repeat_delete_repairs_a_tombstone_made_before_the_scrub_existed():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from datetime import datetime, timezone

        from app.main import app
        from app.models.conversation import ConversationMessage

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        async with Session() as session:  # a stale tombstone: the row is tombstoned, the stored copies are not
            row = (await session.execute(select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(msg_id)))).scalar_one()
            row.deleted_at = datetime.now(timezone.utc)
            row.content = ""
            await session.commit()
        assert [e for e in await _event_payloads(Session, msg_id) if "scrub-me" in e], "the stored copies still carry the words"

        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        assert not [e for e in await _event_payloads(Session, msg_id) if "scrub-me" in e], "the repeat delete scrubs the event rows"
        assert not [n for n in await _notification_rows(Session, conv_id) if n[1] and "scrub-me" in n[1]], "…and the notification rows (they name their message)"
    finally:
        await engine.dispose()


async def test_an_old_form_match_never_blanks_another_kind_of_notification_that_shares_the_room_id_and_the_words():
    engine, Session = await _session_factory()
    try:
        org_id, conv_id, (a_id, a_user), (b_id, b_user), (_c_id, _c_user) = await _room(Session)
        from app.main import app
        from app.models.notification import Notification

        msg_id = await _send(app, Session, a_user, org_id, conv_id, WORDS, [b_id])
        await _make_rows_old_form(Session, [conv_id])
        async with Session() as session:  # another kind of notification about this room, with the same words in its body
            session.add(Notification(id=uuid.uuid4(), org_id=org_id, user_id=b_user, type="chain.escalation", title="escalation", body=WORDS,
                                     reference_type="conversation", reference_id=conv_id))
            await session.commit()
        d = await _as(app, Session, a_user, org_id, lambda c: c.delete(f"/api/v2/conversations/{conv_id}/messages/{msg_id}"))
        assert d.status_code == 200, d.text
        rows = await _notification_rows(Session, conv_id)
        assert [n for n in rows if n[3] == "escalation" and n[1] == WORDS], f"the other kind of notification keeps its body: {rows}"
        assert not [n for n in rows if n[3] != "escalation" and n[1] and "scrub-me" in n[1]], "the message's own old-form rows are scrubbed"
    finally:
        await engine.dispose()
