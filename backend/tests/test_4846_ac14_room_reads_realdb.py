"""story #4846 (AC14) — a room's words are read by the room's participants, on EVERY read road.

AC2: reading a room = being in it (one predicate). The activity stream (`/api/v2/activity-stream`) copies a chat event's payload — the message text — into an activity row, and the activity
log (`/api/v2/activity-logs`) keeps a preview of what an agent said; both were filtered by PROJECT access only, so a member of the room's project who is not in the room could read its words
there. Reproduced first (these tests were red on develop), then the two roads filter by the same room-read predicate.
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


async def _as(Session, w, caller, method, path, json_body=None):
    from app.main import app

    kind, _member, user = _callers(w)[caller]
    await (_setup_app_human if kind == "human" else _setup_app_agent)(app, Session, user, w.org)
    try:
        async with _client_for(app) as c:
            return await c.request(method, path, json=json_body)
    finally:
        app.dependency_overrides.clear()


async def _say(Session, w, caller, conv_id, content):
    r = await _as(Session, w, caller, "POST", f"/api/v2/conversations/{conv_id}/messages", {"content": content, "mentioned_ids": []})
    assert r.status_code == 201, r.text
    return r


async def _stream_text(Session, w, caller, project_id):
    """everything the activity stream shows this caller for a project, as one string (and the status)."""
    r = await _as(Session, w, caller, "GET", f"/api/v2/activity-stream?project_id={project_id}&limit=200&order=desc")
    return r.status_code, r.text


async def _log_text(Session, w, caller, project_id):
    r = await _as(Session, w, caller, "GET", f"/api/v2/activity-logs?project_id={project_id}&limit=100")
    return r.status_code, r.text


async def test_the_activity_stream_does_not_show_a_rooms_words_to_a_project_member_who_is_not_in_the_room():
    engine, Session, w = await _world()
    try:
        words = f"ac14-stream-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "participant", w.r_human, f"for the room only {words}")          # r_human: a room of P1 with people in it; h_c is a P1 member, NOT in it
        st, text = await _stream_text(Session, w, "participant", w.p1)
        assert st == 200 and words in text                                                      # control: a participant of the room sees the line
        st, text = await _stream_text(Session, w, "member_outside", w.p1)
        assert st == 200
        leaked = [(i.get("verb"), i.get("object_type"), sorted((i.get("payload") or {}).keys())) for i in json.loads(text)["items"] if words in json.dumps(i, ensure_ascii=False)]
        assert not leaked, f"a project member who is not in the room read its words in the activity stream, in rows (verb, object_type, payload keys): {leaked}"
    finally:
        await engine.dispose()


async def test_the_activity_log_does_not_show_what_an_agent_said_in_a_room_to_a_project_member_who_is_not_in_it():
    engine, Session, w = await _world()
    try:
        words = f"ac14-log-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "agent_participant", w.r_human, f"agent in the room {words}")     # an agent's message is logged with a preview
        st, text = await _log_text(Session, w, "participant", w.p1)
        assert st == 200 and words in text                                                      # control: a participant sees the preview
        st, text = await _log_text(Session, w, "member_outside", w.p1)
        assert st == 200
        assert words not in text, "a project member who is not in the room read what an agent said in it, in the activity log"
    finally:
        await engine.dispose()


async def test_the_activity_follows_the_same_read_rule_as_the_room_an_agents_only_room_is_for_its_agents_and_the_organization_owner():
    """the SAME predicate, not a look-alike: the room of two agents (no person in it) reads for its participants and for an organization owner/admin — and so does its activity — and
    for no other member of the project."""
    engine, Session, w = await _world()
    try:
        words = f"ac14-agents-{uuid.uuid4().hex[:8]}"
        await _say(Session, w, "agent_participant", w.r_agents, f"between agents {words}")
        for caller, may in (("agent_participant", True), ("org_owner", True), ("member_outside", False), ("participant", False)):
            st, text = await _stream_text(Session, w, caller, w.p1)
            assert st == 200, (caller, st, text[:200])
            assert (words in text) is may, (caller, may)
    finally:
        await engine.dispose()


async def test_the_activity_of_a_rooms_notification_carries_the_message_preview_and_follows_the_same_rule():
    """the bell's `dispatch_notification` writes a `dispatched` event about the ROOM (source = the conversation) whose payload keeps the message preview as `body`; its activity row is
    `object_type=conversation`. Made here exactly as that path makes it, so the test does not wait on a send's side road: a project member who is not in the room must not read it."""
    from app.models.event import Event
    from app.services.activity_stream import upsert_activity_from_events

    engine, Session, w = await _world()
    try:
        words = f"ac14-bell-{uuid.uuid4().hex[:8]}"
        async with Session() as s:
            ev = Event(
                project_id=w.p1, org_id=w.org, event_type="dispatched", source_entity_type="conversation", source_entity_id=w.r_human, sender_id=None,
                recipient_id=w.h_b, recipient_type="human", status="delivered",
                payload={"title": "someone's new message", "body": f"a preview {words}", "event_type": "conversation.message"},
            )
            s.add(ev)
            await s.flush()
            await upsert_activity_from_events(s, [ev.id])
            await s.commit()
        st, text = await _stream_text(Session, w, "participant", w.p1)
        assert st == 200 and words in text                                                      # control: someone in the room sees the row
        st, text = await _stream_text(Session, w, "member_outside", w.p1)
        assert st == 200
        leaked = [(i.get("verb"), i.get("object_type")) for i in json.loads(text)["items"] if words in json.dumps(i, ensure_ascii=False)]
        assert not leaked, f"the activity of the room's notification showed its preview to a project member who is not in the room: {leaked}"
    finally:
        await engine.dispose()
