"""story #4875 — a person's notification row must not hand a room's words back to someone who can no longer read that room (the person's side of 4870).

A message that mentions a person (or is sent in a room they are in) leaves a `notifications` row for them whose `body` is a preview of the message and whose `event` carries the message's own payload (the
card). The list (`GET /api/v2/notifications`) and the single read (`PATCH /api/v2/notifications/{id}/read`) returned those fields as stored — also after the person had left the room. Now they ask the one
room-read question (`conversation_readable_predicate`, the gate of 4870) before handing the preview back: no longer able to read → the preview and the card payload are taken out of the COPY that is
handed back; the row, its title and its read state stay. A person who only lost the project but is still in the room reads on (4846 AC2: a person is not cut by project).
Real Postgres; the first tests here are the reproduction (red before the gate).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as, _put_in_room
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _callers,
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


async def _mention_lost_project_person(Session, w, words: str):
    """h_a (in the room) mentions h_d (in the room, has only P2 — lost P1) in a message: the way a real mention leaves its notification row."""
    r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": f"hello {words}", "mentioned_ids": [str(w.h_d)]})
    assert r.status_code == 201, r.text


async def _list(Session, w, caller="lost_project"):
    r = await _as(Session, w, caller, "GET", "/api/v2/notifications?limit=200")
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _mine(items, words):
    return [n for n in items if words in str(n.get("body") or "") or words in str(n.get("event") or "")]


async def _leave(Session, member, room):
    async with Session() as s:
        await s.execute(text("DELETE FROM conversation_participants WHERE conversation_id = :c AND member_id = :m"), {"c": room, "m": member})
        await s.commit()


async def test_a_mention_notification_of_a_person_still_in_the_room_shows_its_preview_even_without_the_project():
    """the control, and 4846 AC2: h_d lost P1 but is in the room — the preview stays."""
    engine, Session, w = await _world()
    try:
        words = f"n4875-{uuid.uuid4().hex[:8]}"
        await _mention_lost_project_person(Session, w, words)
        got = _mine(await _list(Session, w), words)
        assert got, "the mention left no notification row for h_d (the test world does not produce the case)"
        assert any(words in str(n.get("body") or "") for n in got)
    finally:
        await engine.dispose()


async def test_the_notification_list_does_not_hand_back_the_preview_of_a_room_the_person_has_left():
    engine, Session, w = await _world()
    try:
        words = f"n4875-{uuid.uuid4().hex[:8]}"
        await _mention_lost_project_person(Session, w, words)
        before = [n for n in await _list(Session, w) if n.get("reference_type") == "conversation" and str(n.get("reference_id")) == str(w.r_human)]
        assert any(words in str(n.get("body") or "") for n in before), "setup: the preview is there while h_d is in the room"
        await _leave(Session, w.h_d, w.r_human)
        after = [n for n in await _list(Session, w) if n.get("reference_type") == "conversation" and str(n.get("reference_id")) == str(w.r_human)]
        leaked = [(n["type"], len(n.get("body") or ""), sorted((n.get("event") or {}).keys())) for n in after if words in str(n)]
        assert not leaked, f"after leaving the room the list still handed back the room's words (type, preview chars, event keys): {leaked}"
        assert {n["id"] for n in after} == {n["id"] for n in before}                          # the rows are kept
        assert all(n["title"] for n in after)                                                  # …with their title
    finally:
        await engine.dispose()


async def test_the_single_read_marks_the_row_read_and_hands_back_no_words_of_a_room_the_person_has_left():
    engine, Session, w = await _world()
    try:
        words = f"n4875-{uuid.uuid4().hex[:8]}"
        await _mention_lost_project_person(Session, w, words)
        row = next(n for n in await _list(Session, w) if words in str(n.get("body") or ""))
        await _leave(Session, w.h_d, w.r_human)
        r = await _as(Session, w, "lost_project", "PATCH", f"/api/v2/notifications/{row['id']}/read")
        assert r.status_code == 200, r.text
        body = r.json()["data"] if "data" in r.json() else r.json()
        assert words not in str(body), f"the single read handed back the room's words: body={body.get('body')!r} event={body.get('event')!r}"
        assert body["is_read"] is True and body["title"]                                      # the read state is kept (and saved), the title stays
        again = next(n for n in await _list(Session, w) if n["id"] == row["id"])
        assert again["is_read"] is True and words not in str(again)
    finally:
        await engine.dispose()


async def test_the_words_come_back_when_the_person_is_put_back_in_the_room():
    engine, Session, w = await _world()
    try:
        words = f"n4875-{uuid.uuid4().hex[:8]}"
        await _mention_lost_project_person(Session, w, words)
        await _leave(Session, w.h_d, w.r_human)
        assert not _mine(await _list(Session, w), words)                                      # gone while out
        await _put_in_room(Session, w.r_human, w.h_d)
        assert any(words in str(n.get("body") or "") for n in await _list(Session, w))        # the stored row was never changed: back in the room, the preview is there again
    finally:
        await engine.dispose()


async def _insert_notification(Session, w, *, type_, body, event, reference_id, reference_type="conversation"):
    from app.models.notification import Notification

    async with Session() as s:
        n = Notification(id=uuid.uuid4(), org_id=w.org, user_id=w.u_d, type=type_, title="a title", body=body, is_read=False, reference_type=reference_type, reference_id=reference_id, event=event)
        s.add(n)
        await s.commit()
        return n.id


async def test_a_card_payload_in_the_event_is_taken_out_with_the_preview_and_the_sender_stays():
    engine, Session, w = await _world()
    try:
        words = f"n4875-card-{uuid.uuid4().hex[:8]}"
        nid = await _insert_notification(Session, w, type_="conversation.message", body=f"preview {words}", reference_id=w.r_human,
                                         event={"sender_name": "someone", "event_key": "k", "payload": {"title": words, "summary": words}, "refs": [{"id": "x"}]})
        mine = next(n for n in await _list(Session, w) if n["id"] == str(nid))
        assert words in str(mine)                                                             # in the room: all of it
        await _leave(Session, w.h_d, w.r_human)
        mine = next(n for n in await _list(Session, w) if n["id"] == str(nid))
        assert words not in str(mine) and mine["body"] is None, mine
        assert mine["event"] == {"sender_name": "someone", "content_withheld": True}, mine["event"]   # who wrote stays, the card payload does not
    finally:
        await engine.dispose()


async def test_a_notice_that_points_at_a_room_but_holds_no_message_is_left_as_it_is():
    """the circuit-breaker notice and a computer's turn-ended notice say a sentence of their own: they are not a copy of a room's words and are not touched."""
    engine, Session, w = await _world()
    try:
        nid = await _insert_notification(Session, w, type_="conversation.circuit_breaker_opened", body="agents were paused here", event=None, reference_id=w.r_human)
        await _leave(Session, w.h_d, w.r_human)
        mine = next(n for n in await _list(Session, w) if n["id"] == str(nid))
        assert mine["body"] == "agents were paused here" and mine["event"] is None
    finally:
        await engine.dispose()


async def test_a_message_notification_whose_room_cannot_be_named_gets_no_words():
    engine, Session, w = await _world()
    try:
        words = f"n4875-orphan-{uuid.uuid4().hex[:8]}"
        orphan = await _insert_notification(Session, w, type_="conversation.message", body=f"preview {words}", event={"sender_name": "someone"}, reference_id=None, reference_type=None)
        gone = await _insert_notification(Session, w, type_="conversation.mention", body=f"preview {words}", event={"sender_name": "someone"}, reference_id=uuid.uuid4())   # a room that does not exist
        items = {n["id"]: n for n in await _list(Session, w)}
        assert words not in str(items[str(orphan)]) and words not in str(items[str(gone)])
    finally:
        await engine.dispose()


async def test_a_bare_mention_has_nothing_to_take_out_and_is_handed_back_as_it_is():
    """the mention of someone who is not in the room (AC9) is stored with no preview and an event of only the sender's name: handed back as it is, in or out of the room."""
    engine, Session, w = await _world()
    try:
        nid = await _insert_notification(Session, w, type_="conversation.mention", body=None, event={"sender_name": "someone"}, reference_id=w.r_human)
        await _leave(Session, w.h_d, w.r_human)
        mine = next(n for n in await _list(Session, w) if n["id"] == str(nid))
        assert mine["body"] is None and mine["event"] == {"sender_name": "someone"}
    finally:
        await engine.dispose()
