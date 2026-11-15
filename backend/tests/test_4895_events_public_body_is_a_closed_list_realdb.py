"""story 4895 — `POST /api/v2/events` takes a closed list from the caller; who sent the event is always the caller (filled in by the server).

Before: the route took the whole body as sent. Each place that shows or acts on an event reads some other key as «who sent it» — the bell reads payload.sender_name, the agent connectors payload.sender, the chat
screen payload.created_by, the Kanban board payload.actor_name / actor_id, the activity feed the event's sender (none = «system») — so any member could put a notification in another member's bell, or in an agent's
stream, under a sender of their choosing, make a chat message appear as the recipient's own, or an event look like the system's. Closing those keys one at a time left the next one (four review passes found a new
one each time), so the body is now an allowed list: the accepted event types, the accepted payload keys and the fields the caller really decides (project, recipient); anything else is a 422, and the sender is
filled in from the caller's authentication. The caller must also have a seat in the project (the event becomes an entry in its activity stream).

Real Postgres, real HTTP route. The server's own writers (chat, mentions, publisher) create events in-process and do not pass through this route.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_4846_ac14_room_reads_realdb import _as
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


FORGED = "FORGED-CEO"


def _body(w, payload, **over):
    return {"project_id": str(w.p1), "event_type": "dispatched", "recipient_id": str(w.h_b), "payload": payload, **over}


async def _name_of(Session, member_id) -> str:
    async with Session() as s:
        return (await s.execute(text("SELECT name FROM members WHERE id = :i"), {"i": member_id})).scalar_one()


async def _event_row(Session, event_id):
    async with Session() as s:
        return (await s.execute(text("SELECT payload, sender_id, recipient_type, source_entity_type FROM events WHERE id = :i"), {"i": event_id})).one()


async def _stored_with(Session, needle) -> tuple[int, int]:
    """(events, activity rows) whose payload carries the needle"""
    async with Session() as s:
        ev = (await s.execute(text("SELECT count(*) FROM events WHERE payload::text LIKE :n"), {"n": f"%{needle}%"})).scalar_one()
        act = (await s.execute(text("SELECT count(*) FROM activity_events WHERE payload::text LIKE :n"), {"n": f"%{needle}%"})).scalar_one()
    return ev, act


# ── the sender is the caller's own ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("caller,kind", [("participant", "human"), ("agent_participant", "agent"), ("agent_plain", "agent")])
async def test_the_stored_sender_is_the_callers_own_in_every_place_it_is_read(caller, kind):
    engine, Session, w = await _world()
    try:
        member = _callers(w)[caller][1]
        real = await _name_of(Session, member)
        mark = f"honest-4895-{uuid.uuid4().hex[:8]}"
        r = await _as(Session, w, caller, "POST", "/api/v2/events", _body(w, {"content": mark, "title": "t"}))
        assert r.status_code == 201, r.text
        payload, sender_id, rtype, source_type = await _event_row(Session, r.json()["id"])
        assert payload == {"content": mark, "title": "t", "sender_name": real, "sender": {"id": str(member), "name": real, "type": kind}}, payload
        assert sender_id == member, "the event's sender (what the activity feed and the gateway read) is the caller"
        assert source_type is None
        assert r.json()["sender_id"] == str(member) and r.json()["payload"]["sender_name"] == real
        async with Session() as s:
            actor = (await s.execute(text("SELECT actor_id FROM activity_events WHERE payload::text LIKE :n"), {"n": f"%{mark}%"})).scalar_one()
        assert actor == member, "and the activity's actor is the caller, not none («system»)"
    finally:
        await engine.dispose()


async def test_an_organization_owner_without_a_project_seat_is_named_the_way_the_rest_of_the_server_names_them():
    """a person known only through the organization has no seat name: the server's usual stand-in label is used — never one the caller chose"""
    from app.services.member_resolver import UNNAMED_MEMBER_LABEL

    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "org_owner", "POST", "/api/v2/events", _body(w, {"content": "c"}))
        assert r.status_code == 201, r.text
        payload = (await _event_row(Session, r.json()["id"]))[0]
        assert payload["sender_name"] == UNNAMED_MEMBER_LABEL and payload["sender"]["name"] == UNNAMED_MEMBER_LABEL
    finally:
        await engine.dispose()


# ── a closed list: anything else is a 422 and nothing is stored ───────────────────────────────────────────────────

IDENTITY_AND_OTHER_PAYLOAD_KEYS = [
    "sender_name", "sender", "created_by", "actor_name", "actor_id", "actor", "author", "from", "sender_id", "agent_name", "gate_name",
    "event_type", "conversation_id", "thread_id", "audience", "attachments", "id", "created_at", "name", "anything_new",
]


@pytest.mark.parametrize("key", IDENTITY_AND_OTHER_PAYLOAD_KEYS)
async def test_a_payload_key_outside_the_accepted_ones_is_refused_and_nothing_is_stored(key):
    engine, Session, w = await _world()
    try:
        mark = f"refused-key-4895-{uuid.uuid4().hex[:8]}"
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {"content": mark, key: FORGED}))
        assert r.status_code == 422, (key, r.text[:300])
        assert key in r.text and "accepted keys are" in r.text, "it says which key and which ones are accepted"
        assert await _stored_with(Session, mark) == (0, 0)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("key", ["content", "title", "body", "summary"])
@pytest.mark.parametrize("value", [{"sender": " another person "}, ["x"], 1, True, None])
async def test_the_accepted_payload_keys_take_text_only_an_object_or_a_number_would_break_the_readers_after_the_201(key, value):
    """the agent connectors strip / trim the content and the bell replaces in the summary: a non-text value passed the key check and broke the reader later"""
    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {key: value}))
        assert r.status_code == 422, (key, value, r.text[:300])
        assert "must be text" in r.text and key in r.text
    finally:
        await engine.dispose()


@pytest.mark.parametrize("field", ["sender_id", "source_entity_type", "source_entity_id", "created_by", "actor_name", "anything_new"])
async def test_a_field_outside_the_accepted_ones_is_refused_not_ignored(field):
    engine, Session, w = await _world()
    try:
        mark = f"refused-field-4895-{uuid.uuid4().hex[:8]}"
        value = str(w.h_a) if field.endswith("_id") else FORGED
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {"content": mark}, **{field: value}))
        assert r.status_code == 422, (field, r.text[:300])
        assert await _stored_with(Session, mark) == (0, 0)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("event_type", ["dispatched", "kickoff", "review_request", "qa_request", "deploy_request", "handoff"])
async def test_the_accepted_event_types_pass(event_type):
    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {"content": "c"}, event_type=event_type))
        assert r.status_code == 201, (event_type, r.text[:300])
    finally:
        await engine.dispose()


@pytest.mark.parametrize(
    "event_type",
    ["conversation.message_created", "conversation:mention", "story.status_changed", "story.assignee_changed", "story_assigned", "memo_created", "gate_created", "a2a.task_message", "whatever"],
)
async def test_any_other_event_type_is_refused_and_the_answer_lists_the_accepted_ones(event_type):
    """chat, story and gate events are the server's own: the chat screen takes their sender / created_by for who spoke, the board takes actor_name / actor_id for who acted"""
    engine, Session, w = await _world()
    try:
        mark = f"refused-type-4895-{uuid.uuid4().hex[:8]}"
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {"content": mark}, event_type=event_type))
        assert r.status_code == 422, (event_type, r.text[:300])
        assert "accepted types are" in r.text and "dispatched" in r.text
        assert await _stored_with(Session, mark) == (0, 0)
    finally:
        await engine.dispose()


async def test_an_empty_payload_and_a_recipient_type_that_disagrees_are_fine_the_server_decides_the_kind():
    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {}, recipient_type="agent"))   # w.h_b is a person
        assert r.status_code == 201, r.text
        payload, _sender, rtype, _src = await _event_row(Session, r.json()["id"])
        assert rtype == "human", "the recipient's kind is what the server resolved, not what was sent"
        assert set(payload) == {"sender_name", "sender"}
    finally:
        await engine.dispose()


# ── a seat in the project ────────────────────────────────────────────────────────────────────────────────────────

async def test_a_member_with_no_seat_in_the_project_cannot_write_an_event_into_it():
    """the event is an entry in the project's activity stream: measured on develop, a caller with no seat in the project got 201"""
    engine, Session, w = await _world()
    try:
        mark = f"no-seat-4895-{uuid.uuid4().hex[:8]}"
        r = await _as(Session, w, "lost_project", "POST", "/api/v2/events", _body(w, {"content": mark}, recipient_id=str(w.h_d)))
        assert r.status_code == 404, r.text
        assert await _stored_with(Session, mark) == (0, 0)
        seated = f"with-seat-4895-{uuid.uuid4().hex[:8]}"
        r = await _as(Session, w, "participant", "POST", "/api/v2/events", _body(w, {"content": seated}))
        assert r.status_code == 201, r.text
        assert await _stored_with(Session, seated) == (1, 1)
    finally:
        await engine.dispose()


async def test_the_servers_own_event_roads_do_not_take_the_seat_check_a_room_message_from_a_person_without_a_seat_still_writes_its_events():
    """the check is on the public route only. Measured on production, the senders without a seat are the server's own writers (room messages, mentions, assignments)"""
    engine, Session, w = await _world()
    try:
        r = await _as(Session, w, "lost_project", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "no-seat-voice-4895", "mentioned_ids": [str(w.h_b)]})
        assert r.status_code == 201, r.text
        async with Session() as s:
            rows = (await s.execute(text("SELECT count(*) FROM events WHERE sender_id = :u AND project_id = :p"), {"u": w.h_d, "p": w.p1})).scalar_one()
        assert rows >= 1
        r = await _as(Session, w, "lost_project", "POST", "/api/v2/events", _body(w, {}, recipient_id=str(w.h_d)))
        assert r.status_code == 404
    finally:
        await engine.dispose()
