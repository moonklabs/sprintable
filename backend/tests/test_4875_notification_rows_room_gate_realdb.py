"""story #4875 — a person's notification rows (`notifications`) keep a copy of a room's words (`body` = the message preview, `event` = the card of an event-publishing message); the bell
list and mark-read handed them back whatever the person's place in the room is NOW. 4870 put the room-read question in front of the roads that read a stored `events` copy back; this is
the person's side of the same rule: «may this caller read this room NOW» (the 4846 predicate, one question per page), and if not the words are taken out of the copy handed back — the row
and its read state stay, in the shape a mention from outside the room already has (AC9: title, no body, the sender's name only). A person is not cut by project (a person who lost the
project and is still in the room reads on). The stored row is never changed.
Reproduced first (red on develop), then green.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as, _say
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _list(Session, w, caller):
    r = await _as(Session, w, caller, "GET", "/api/v2/notifications?limit=200")
    assert r.status_code == 200, r.text
    return r


def _rows_of(r, room):
    return [n for n in r.json()["data"] if n.get("reference_id") == str(room)]


async def _leave(Session, room, member):
    async with Session() as s:
        await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m"), {"c": room, "m": member})
        await s.commit()


async def _join(Session, room, member):
    from app.models.conversation import ConversationParticipant

    async with Session() as s:
        s.add(ConversationParticipant(conversation_id=room, member_id=member))
        await s.commit()


async def _stored(Session, notif_id) -> str:
    async with Session() as s:
        return (await s.execute(text("SELECT coalesce(body,'') || coalesce(event::text,'') FROM notifications WHERE id = :i"), {"i": notif_id})).scalar_one()


async def test_a_person_who_left_the_room_is_not_handed_its_words_by_the_bell_list_and_mark_read():
    engine, Session, w = await _world()
    try:
        words = f"ac4875-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "participant", w.r_human, f"for the room only {words}")      # h_a says it in r_human; h_d is in the room too and has no access to P1: its other people (h_b · h_d) get «a new message» in their bell
        r = await _list(Session, w, "lost_project")
        rows = _rows_of(r, w.r_human)
        assert rows and words in r.text, "control: a person IN the room reads the preview (and a person who lost the project is still in it)"
        notif_id = rows[0]["id"]

        await _leave(Session, w.r_human, w.h_d)                                                # the person leaves the room
        r = await _list(Session, w, "lost_project")
        rows = _rows_of(r, w.r_human)
        assert rows, "the bell item stays (title, read state)"
        assert words not in r.text, r.text
        assert all((n.get("body") in (None, "")) for n in rows), rows
        r = await _as(Session, w, "lost_project", "PATCH", f"/api/v2/notifications/{notif_id}/read")
        assert r.status_code == 200 and r.json()["is_read"] is True and words not in r.text, r.text   # the read mark works; its answer carries no words
        assert words in await _stored(Session, notif_id), "nothing is written back: the stored row keeps the words"

        await _join(Session, w.r_human, w.h_d)                                                 # put back in: the words are back (the copy was only withheld)
        r = await _list(Session, w, "lost_project")
        assert words in r.text
    finally:
        await engine.dispose()


async def test_a_person_who_only_lost_the_project_keeps_reading_their_room_notifications_and_other_bell_items_are_untouched():
    engine, Session, w = await _world()
    try:
        words = f"ac4875-keep-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "participant", w.r_human, f"keep {words}")
        r = await _list(Session, w, "lost_project")
        assert words in r.text and _rows_of(r, w.r_human)                                      # h_d lost P1, is in the room: not cut by project (4846 AC2)

        # a bell item that is NOT about a room's words is never touched, whoever reads it
        other = f"other-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO notifications (id, org_id, user_id, type, title, body, reference_type, reference_id) "
                "VALUES (gen_random_uuid(), :o, :u, 'story_assigned', 'assigned', :b, 'story', gen_random_uuid())"), {"o": w.org, "u": w.u_d, "b": other})
            await s.commit()
        await _leave(Session, w.r_human, w.h_d)
        r = await _list(Session, w, "lost_project")
        assert other in r.text, "a story notification keeps its body whatever the room says"
        assert words not in r.text
    finally:
        await engine.dispose()


@pytest.mark.parametrize("kind", ["conversation.message", "conversation.mention"])
async def test_the_event_card_of_an_event_publishing_message_is_withheld_with_the_preview(kind):
    """the `event` column of a message notification carries `{sender_name, event_key, payload, refs}` of the message's own event payload — words too. Withheld: only the sender's name stays."""
    engine, Session, w = await _world()
    try:
        card = f"card-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO notifications (id, org_id, user_id, type, title, body, reference_type, reference_id, event) "
                "VALUES (gen_random_uuid(), :o, :u, CAST(:k AS text), 'X님의 새 메시지', 'preview', 'conversation', :r, CAST(:e AS jsonb))"),
                {"o": w.org, "u": w.u_c, "r": w.r_human, "k": kind, "e": '{"sender_name": "X", "event_key": "k", "payload": {"note": "%s"}, "refs": {}}' % card})   # h_c is NOT in r_human
            await s.commit()
        r = await _list(Session, w, "member_outside")
        rows = _rows_of(r, w.r_human)
        assert rows and card not in r.text and "preview" not in r.text, r.text
        assert rows[0]["event"] == {"sender_name": "X"}, rows[0]["event"]
        assert rows[0]["title"] == "X님의 새 메시지"
    finally:
        await engine.dispose()


async def _insert_notification(Session, w, user, kind, room, body, event=None):
    async with Session() as s:
        await s.execute(text(
            "INSERT INTO notifications (id, org_id, user_id, type, title, body, reference_type, reference_id, event) "
            "VALUES (gen_random_uuid(), :o, :u, :k, 'T', :b, :rt, :r, CAST(:e AS jsonb))"),
            {"o": w.org, "u": user, "k": kind, "b": body, "rt": "conversation" if room is not None else None, "r": room, "e": event})
        await s.commit()


async def test_an_organization_owner_reads_the_notification_of_a_room_of_agents_only_but_not_of_a_room_with_a_person_in_it():
    """the predicate's own rule (4846 AC2), not a look-alike: an owner/admin is let into a room with no person in it, never into one with a person."""
    engine, Session, w = await _world()
    try:
        agents_words, people_words = f"agents-{uuid.uuid4().hex[:8]}", f"people-{uuid.uuid4().hex[:8]}"
        await _insert_notification(Session, w, w.u_o, "conversation.message", w.r_agents, agents_words)
        await _insert_notification(Session, w, w.u_o, "conversation.message", w.r_human, people_words)
        r = await _list(Session, w, "org_owner")
        assert agents_words in r.text and people_words not in r.text, r.text
    finally:
        await engine.dispose()


async def test_a_card_with_no_preview_a_room_that_does_not_exist_and_a_row_with_no_reference_are_all_withheld():
    engine, Session, w = await _world()
    try:
        card, ghost, bare = (f"{n}-{uuid.uuid4().hex[:8]}" for n in ("card", "ghost", "bare"))
        await _insert_notification(Session, w, w.u_c, "conversation.message", w.r_human, None, '{"sender_name": "X", "payload": {"note": "%s"}}' % card)     # h_c is not in r_human; body None, words only in the card
        await _insert_notification(Session, w, w.u_c, "conversation.mention", uuid.uuid4(), ghost)                                                         # a room that does not exist
        async with Session() as s:                                                                                                                         # a legacy row: the kind, no reference
            await s.execute(text("INSERT INTO notifications (id, org_id, user_id, type, title, body) VALUES (gen_random_uuid(), :o, :u, 'conversation.message', 'T', :b)"), {"o": w.org, "u": w.u_c, "b": bare})
            await s.commit()
        r = await _list(Session, w, "member_outside")
        assert card not in r.text and ghost not in r.text and bare not in r.text, r.text
        assert len([n for n in r.json()["data"] if n["type"].startswith("conversation.")]) >= 3, "the bell items stay"
    finally:
        await engine.dispose()
