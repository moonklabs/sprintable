"""story 5034 (C4 step 2) — the chat `card` is written by the SERVER only, on a real database and the real HTTP routes.

A person or an agent in a room cannot stamp a message with a card (422, nothing stored); the server's own in-process road stores `{kind, ref}` in the message's `metadata` and every read of the room
serves it as `card`; the other messages serve `card: null`; the public body model does not advertise `card` as an input.
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

ID = "0d6e953f-6d43-42c1-a87c-b023544497db"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _count(Session, room) -> int:
    async with Session() as s:
        return (await s.execute(text("SELECT count(*) FROM conversation_messages WHERE conversation_id = :c"), {"c": room})).scalar_one()


@pytest.mark.parametrize("caller", ["participant", "agent_participant"])
@pytest.mark.parametrize("card", [{"kind": "story", "ref": ID}, {"kind": "agent_action", "ref": ID}, {"kind": "timeline", "ref": "x"}, {}, "story"])  # story 5041: the approval card is the server's alone
async def test_a_card_sent_to_the_public_route_is_refused_and_nothing_is_stored(caller, card):
    engine, Session, w = await _world()
    try:
        before = await _count(Session, w.r_human)
        r = await _as(Session, w, caller, "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "a card from a client", "mentioned_ids": [], "card": card})
        assert r.status_code == 422, r.text
        assert "server only" in r.text, "it says why"
        assert await _count(Session, w.r_human) == before, "no message was written"
    finally:
        await engine.dispose()


async def test_messages_without_a_card_are_untouched_and_serve_card_null():
    engine, Session, w = await _world()
    try:
        for extra in ({}, {"card": None}):
            r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", {"content": "plain", "mentioned_ids": [], **extra})
            assert r.status_code == 201, (extra, r.text)
        listed = await _as(Session, w, "participant", "GET", f"/api/v2/conversations/{w.r_human}/messages")
        assert listed.status_code == 200, listed.text
        rows = (listed.json().get("data") or listed.json())
        assert rows and all("card" in m and m["card"] is None for m in rows), rows
    finally:
        await engine.dispose()


async def test_the_servers_own_road_stores_a_card_and_every_read_of_the_room_serves_it():
    engine, Session, w = await _world()
    try:
        msg = await say_with_server_card(Session, w, "agent_participant", w.r_human, "here is the story", card={"kind": "story", "ref": ID.upper()})
        async with Session() as s:
            stored = (await s.execute(text("SELECT metadata FROM conversation_messages WHERE id = :i"), {"i": msg})).scalar_one()
        assert (stored or {}).get("card") == {"kind": "story", "ref": ID}, stored
        for caller in ("participant", "agent_participant"):
            listed = await _as(Session, w, caller, "GET", f"/api/v2/conversations/{w.r_human}/messages")
            assert listed.status_code == 200, listed.text
            rows = listed.json().get("data") or listed.json()
            mine = [m for m in rows if m["id"] == str(msg)]
            assert mine and mine[0]["card"] == {"kind": "story", "ref": ID}, (caller, mine)
    finally:
        await engine.dispose()


def test_the_public_routes_schema_does_not_offer_card_as_input():
    from app.main import app

    body = app.openapi()["components"]["schemas"]["HttpSendMessageRequest"]["properties"]["card"]
    dumped = json.dumps(body).lower()
    assert "server" in dumped and "object" not in dumped, body
    assert "null" in dumped, body
