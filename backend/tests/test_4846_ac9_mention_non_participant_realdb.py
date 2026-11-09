"""story #4846 (AC9) — the words of a message do not go to a person who is not in the room.

A group room's mention of someone who is not in it used to send them a `conversation:mention` event WITH the message text (and a bell notification with a preview): they could not read
the room (403) but could read the words. Now: if the sender could ADD them (the same gate as «add a participant»: the agents' creator / allowlist policy), the mention puts them in the
room and the message — and what follows — reaches them as it reaches any participant; if the sender could not, they keep the mention (the bell) and nothing of the words.
"""
from __future__ import annotations

import json
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import _client_for, _setup_app_agent, _setup_app_human
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


async def _say(Session, w, caller, conv_id, content, mentioned=(), extra=None):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            r = await c.post(f"/api/v2/conversations/{conv_id}/messages",
                             json={"content": content, "mentioned_ids": [str(m) for m in mentioned], **(extra or {})})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text
    body = r.json()
    return uuid.UUID((body.get("data") or body)["id"])


async def _participant_ids(Session, conv_id):
    from sqlalchemy import text

    async with Session() as s:
        return set((await s.execute(text("SELECT member_id FROM conversation_participants WHERE conversation_id = :c"), {"c": conv_id})).scalars().all())


async def _events_for(Session, msg_id, member_id):
    """(event_type, payload as text) of every event of this message addressed to this member."""
    from sqlalchemy import text

    async with Session() as s:
        return [(r[0], r[1]) for r in (await s.execute(
            text("SELECT event_type, payload::text FROM events WHERE source_entity_id = :m AND recipient_id = :r ORDER BY event_type"),
            {"m": msg_id, "r": member_id},
        )).all()]


async def _notification_texts(Session, w, user_id, conv_id):
    """body + event of every bell notification this user got for this room."""
    from sqlalchemy import text

    async with Session() as s:
        return [(r[0], r[1]) for r in (await s.execute(
            text("SELECT body, event::text FROM notifications WHERE user_id = :u AND reference_id = :c"), {"u": user_id, "c": conv_id},
        )).all()]


async def _people_room(Session, w):
    """a group room of two people, no project, no agent: nothing but the sender's own standing decides whether a third person can be added."""
    from tests.test_1994_backlink_api_realdb import _make_conversation

    async with Session() as s:
        return await _make_conversation(s, w.org, None, [w.h_a, w.h_b], w.h_a, "group")


async def test_a_person_who_can_add_them_puts_a_mentioned_outsider_in_the_room_and_the_words_reach_them_as_a_participant():
    engine, Session, w = await _world()
    try:
        room = await _people_room(Session, w)
        words = f"ac9-words-{uuid.uuid4().hex[:8]}"
        assert w.h_c not in await _participant_ids(Session, room)                           # outside the room (a room with no project)
        msg = await _say(Session, w, "participant", room, f"hello {words}", mentioned=[w.h_c])
        assert w.h_c in await _participant_ids(Session, room)                                # put in the room by the mention
        got = await _events_for(Session, msg, w.h_c)
        assert got and all(words in payload for _t, payload in got)                           # as a participant: the message itself
        later = await _say(Session, w, "participant", room, "and after the mention")
        assert await _events_for(Session, later, w.h_c)                                      # what follows reaches them too
    finally:
        await engine.dispose()


async def test_a_person_cannot_put_an_outsider_in_a_room_with_an_agent_that_does_not_allow_them_so_they_get_the_bell_only():
    """the room has an agent whose creator is not among the people (the agents' creator policy): the same gate that refuses «add a participant» refuses the mention's adding."""
    engine, Session, w = await _world()
    try:
        words = f"ac9-policy-{uuid.uuid4().hex[:8]}"
        before = await _participant_ids(Session, w.n_human)
        msg = await _say(Session, w, "participant", w.n_human, f"people and an agent here {words}", mentioned=[w.h_c])
        assert await _participant_ids(Session, w.n_human) == before
        mention = await _events_for(Session, msg, w.h_c)
        assert [t for t, _p in mention] == ["conversation:mention"] and words not in mention[0][1]
    finally:
        await engine.dispose()


async def test_an_agent_that_cannot_add_them_leaves_the_mentioned_outsider_the_bell_and_none_of_the_words():
    engine, Session, w = await _world()
    try:
        words = f"ac9-secret-{uuid.uuid4().hex[:8]}"
        before = await _participant_ids(Session, w.n_human)
        assert w.h_c not in before
        # an agent that does not have the person's creator among the room's people (the agent's creator must be a participant): the sender could NOT add them
        # the message also carries an event card (a message published as an event has one): its payload must not travel either
        msg = await _say(Session, w, "agent_participant", w.n_human, f"for the room only {words}", mentioned=[w.h_c],
                         extra={"event_context": {"event_key": "ac9.test", "payload": {"note": words}}})
        assert await _participant_ids(Session, w.n_human) == before                           # not put in the room
        mention = await _events_for(Session, msg, w.h_c)
        assert [t for t, _p in mention] == ["conversation:mention"]                           # the bell stays
        payload = json.loads(mention[0][1])
        assert words not in mention[0][1]                                                      # no words anywhere in the event
        assert payload.get("content") == "" and payload.get("attachments") == [] and payload.get("content_withheld") is True
        assert payload.get("id") == str(msg) and payload.get("conversation_id") == str(w.n_human)   # that somebody mentioned them, where
        for body, event in await _notification_texts(Session, w, w.u_c, w.n_human):            # nor in the notification (preview) they get
            assert words not in (body or "") and words not in (event or "")
    finally:
        await engine.dispose()


async def test_a_mention_of_someone_already_in_the_room_is_unchanged():
    engine, Session, w = await _world()
    try:
        words = f"ac9-control-{uuid.uuid4().hex[:8]}"
        before = await _participant_ids(Session, w.n_human)
        msg = await _say(Session, w, "participant", w.n_human, f"hi {words}", mentioned=[w.h_b])
        assert await _participant_ids(Session, w.n_human) == before
        got = await _events_for(Session, msg, w.h_b)
        assert got and all(words in payload for _t, payload in got)                           # a participant keeps the words
    finally:
        await engine.dispose()


async def test_a_mentioned_agent_without_the_rooms_project_is_not_put_in_the_room_and_gets_no_words_while_one_with_it_is():
    """an agent reads a room WITH a project only while it has that project (AC12): putting one that does not in the room would send it the whole message to a seat it cannot
    read. (Both agents allow everyone — org_wide — so the creator policy passes and only the project decides.)"""
    from sqlalchemy import text

    from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_conversation

    engine, Session, w = await _world()
    try:
        async with Session() as s:
            outside = await _make_agent_member(s, w.org, w.p2)                     # has P2 only
            inside = await _make_agent_member(s, w.org, w.p1)                      # has P1
            outside, inside = (a if isinstance(a, uuid.UUID) else a.id for a in (outside, inside))
            await s.execute(text("UPDATE members SET message_policy_mode = 'org_wide' WHERE id IN (:a, :b)"), {"a": outside, "b": inside})
            await s.commit()
            room = await _make_conversation(s, w.org, w.p1, [w.h_a, w.h_b], w.h_a, "group")     # a room WITH project P1, two people
        words = f"ac9-project-{uuid.uuid4().hex[:8]}"
        msg = await _say(Session, w, "participant", room, f"for P1 {words}", mentioned=[outside, inside])
        members = await _participant_ids(Session, room)
        assert outside not in members and inside in members                                    # the one without P1 stays out, the one with P1 is put in
        out_events = await _events_for(Session, msg, outside)
        assert [t for t, _p in out_events] == ["conversation:mention"] and words not in out_events[0][1]
        in_events = await _events_for(Session, msg, inside)
        assert in_events and all(words in p for _t, p in in_events)
    finally:
        await engine.dispose()


async def test_what_is_pushed_live_to_a_mentioned_outsider_carries_none_of_the_words_either():
    """the persisted event is one thing, the live push (SSE) another: both are built from the same payload, and a change to one must not leak through the other."""
    from unittest.mock import patch

    engine, Session, w = await _world()
    try:
        words = f"ac9-live-{uuid.uuid4().hex[:8]}"
        pushed: list = []
        with patch("app.routers.conversations._push_to_agent", side_effect=lambda pid, payload: pushed.append((str(pid), payload))):
            await _say(Session, w, "agent_participant", w.n_human, f"live push {words}", mentioned=[w.h_c],
                       extra={"event_context": {"event_key": "ac9.test", "payload": {"note": words}}})
        mine = [p for pid, p in pushed if pid == str(w.h_c)]
        assert mine, pushed                                                                    # the mention IS pushed to them (the bell)
        assert all(words not in json.dumps(p, default=str) for p in mine)                      # without a word
        assert all(p.get("content_withheld") is True for p in mine)
    finally:
        await engine.dispose()
