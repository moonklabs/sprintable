"""story 4894 — `event_context` (the card of a message the SERVER published) cannot be sent to the public message route.

Before: `POST /api/v2/conversations/{id}/messages` took `event_context` from anyone in the room — a person or an agent could stamp a message with the card of an event the server never
published (`preset.gate.verdict` with names and links of their choosing in `refs`); it was stored in `msg_metadata`, delivered to the readers of the room and copied into the other
participants' notification rows. Reproduced first (these tests were red on develop), then the public route's body model refuses any value (422).

Real Postgres, real HTTP routes. The server's own publisher is not touched: it builds the request in-process and hands it to the message function (`tests/_server_card.py` takes that road).
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

from tests._server_card import say_with_server_card
from tests.test_4846_ac14_room_reads_realdb import _as
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


FORGED = {
    "event_key": "preset.gate.verdict",
    "payload": {"verdict": "approved", "note": "FORGED-APPROVAL"},
    "refs": {"assignee": {"name": "FORGED-CEO"}, "assigned_by": {"name": "FORGED-CEO"}},
    "sender_name": "FORGED-CEO",
}


async def _count(Session, room) -> int:
    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE conversation_id = :c"), {"c": room})).scalar_one()


async def _notification_rows_with(Session, room, needle) -> int:
    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM notifications WHERE reference_id = :c AND coalesce(event::text, '') LIKE :n"), {"c": room, "n": f"%{needle}%"})).scalar_one()


@pytest.mark.parametrize("caller", ["participant", "agent_participant"])
async def test_a_card_sent_to_the_public_route_is_refused_and_nothing_is_stored(caller):
    engine, Session, w = await _world()
    try:
        before = await _count(Session, w.r_human)
        r = await _as(Session, w, caller, "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "looks like a system card", "mentioned_ids": [], "event_context": FORGED})
        assert r.status_code == 422, r.text
        assert "server only" in r.text, "it says why"
        assert await _count(Session, w.r_human) == before, "no message was written"
        assert await _notification_rows_with(Session, w.r_human, "FORGED-CEO") == 0, "no other participant's notification carries the card"
    finally:
        await engine.dispose()


async def test_even_a_bare_or_odd_card_is_refused_not_just_a_forged_looking_one():
    engine, Session, w = await _world()
    try:
        for card in ({}, {"event_key": "x"}, {"anything": [1, 2, 3]}):
            r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "c", "mentioned_ids": [], "event_context": card})
            assert r.status_code == 422, (card, r.text)
    finally:
        await engine.dispose()


async def test_messages_without_a_card_are_untouched_including_an_explicit_null_a_work_item_and_a_mention():
    engine, Session, w = await _world()
    try:
        for extra in ({}, {"event_context": None}, {"work_item": {"type": "story", "id": str(uuid.uuid4())}}):
            r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "plain", "mentioned_ids": [], **extra})
            assert r.status_code == 201, (extra, r.text)
        r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "hi", "mentioned_ids": [str(w.h_b)]})
        assert r.status_code == 201, r.text
    finally:
        await engine.dispose()


async def test_the_servers_own_in_process_road_still_stores_and_delivers_a_card():
    """the publisher's road: nothing the server publishes changed"""
    engine, Session, w = await _world()
    try:
        card = {"event_key": "preset.test.card", "payload": {"note": "SERVER-CARD"}, "refs": {"work_item": {"id": "x"}}}
        msg = await say_with_server_card(Session, w, "agent_participant", w.r_human, "a server card", event_context=card)
        async with Session() as s:
            stored = (await s.execute(text("SELECT metadata FROM conversation_messages WHERE id = :i"), {"i": msg})).scalar_one()
        assert (stored or {}).get("event") == card, stored
        assert await _notification_rows_with(Session, w.r_human, "SERVER-CARD") >= 1, "the room's people get the card on their bell as before"
    finally:
        await engine.dispose()


def test_the_public_routes_schema_does_not_offer_event_context_as_input():
    from app.main import app

    schema = app.openapi()
    body = schema["components"]["schemas"]["HttpSendMessageRequest"]["properties"]["event_context"]
    assert "server" in json.dumps(body).lower() and body.get("type") in (None, "null") or "null" in json.dumps(body), body
    assert "dict" not in json.dumps(body) and "object" not in json.dumps(body), "it is not advertised as a free object any more"
