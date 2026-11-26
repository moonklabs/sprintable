"""story 5046 (C13) — WHEN a working agent gets a chat message: the sender's choice (`delivery_mode`) and the server's record of how it went into the agent's turn (`delivery_log`), on a real database and the real routes.

Red when: a message sent the old way (no mode / `now`) carries ANY new key (the default is the meaning of today) · `after_turn` does not reach the agent's event payload and the room's reads · a value outside the two words is
accepted · a caller of the public message route can write the server's `delivery_log` · an agent that is NOT a recipient of the message (another agent, a person, a message of another room, a missing message) can report — each is the same 404 /
403 · the first report of an agent is not the one that stays (a host retry or a later report rewrites history) · the TIME is not the server's own · a message's tombstone serves a delivery line.
"""
from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text

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


def _msgs(room):
    return f"/api/v2/conversations/{room}/messages"


def _report(room, msg):
    return f"/api/v2/conversations/{room}/messages/{msg}/delivery"


async def _send(Session, w, room, **extra):
    # a person calling the agent by name (an agent in a group room receives only the words that call it — story 5030)
    r = await _as(Session, w, "participant", "POST", _msgs(room), {"content": "hello", "mentioned_ids": [str(w.g_p)], **extra})
    return r, (uuid.UUID((r.json().get("data") or r.json())["id"]) if r.status_code == 201 else None)


async def _event_payload(Session, msg, recipient):
    async with Session() as s:
        row = (await s.execute(text("SELECT payload FROM events WHERE source_entity_id = :m AND recipient_id = :r"), {"m": msg, "r": recipient})).first()
    assert row is not None, "the agent has no event for the message"
    return row[0] if isinstance(row[0], dict) else json.loads(row[0])


async def _read(Session, w, room, msg):
    r = await _as(Session, w, "participant", "GET", _msgs(room))
    assert r.status_code == 200, r.text
    rows = r.json().get("data") or r.json()
    return next(m for m in rows if m["id"] == str(msg))


async def test_a_message_sent_the_old_way_carries_no_new_key_anywhere():
    engine, Session, w = await _world()
    try:
        for extra in ({}, {"delivery_mode": "now"}, {"delivery_mode": None}):
            r, msg = await _send(Session, w, w.r_human, **extra)
            assert r.status_code == 201, r.text
            payload = await _event_payload(Session, msg, w.g_p)
            assert "delivery_mode" not in payload and "delivery_log" not in payload, (extra, payload)
            read = await _read(Session, w, w.r_human, msg)
            assert "delivery_mode" not in read and "delivery_log" not in read, (extra, read)
            async with Session() as s:
                meta = (await s.execute(text("SELECT metadata FROM conversation_messages WHERE id = :m"), {"m": msg})).scalar_one()
            assert not (isinstance(meta, dict) and "mode" in (meta.get("delivery") or {})), meta
    finally:
        await engine.dispose()


async def test_after_turn_reaches_the_agents_event_and_the_rooms_reads_and_nothing_else_changes():
    engine, Session, w = await _world()
    try:
        r, msg = await _send(Session, w, w.r_human, delivery_mode="after_turn")
        assert r.status_code == 201, r.text
        assert (await _event_payload(Session, msg, w.g_p))["delivery_mode"] == "after_turn"
        assert (await _read(Session, w, w.r_human, msg))["delivery_mode"] == "after_turn"
    finally:
        await engine.dispose()


@pytest.mark.parametrize("bad", ["later", "NOW", "", 1, ["after_turn"]])
async def test_a_value_outside_the_two_words_is_refused(bad):
    engine, Session, w = await _world()
    try:
        r, _ = await _send(Session, w, w.r_human, delivery_mode=bad)
        assert r.status_code == 422, (bad, r.text)
    finally:
        await engine.dispose()


async def test_the_public_route_cannot_write_the_servers_delivery_log():
    engine, Session, w = await _world()
    try:
        r, msg = await _send(Session, w, w.r_human, delivery_log={str(w.g_p): {"via": "turn", "at": "2020-01-01T00:00:00+00:00"}})
        assert r.status_code == 201, r.text  # an unknown word is ignored, never stored
        assert "delivery_log" not in await _read(Session, w, w.r_human, msg)
        assert "delivery_log" not in await _event_payload(Session, msg, w.g_p)
    finally:
        await engine.dispose()


async def test_the_recipient_agent_reports_once_the_first_report_stays_and_the_time_is_the_servers():
    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human, delivery_mode="after_turn")
        first = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), {"via": "next_turn"})
        assert first.status_code == 200, first.text
        line = first.json().get("data") or first.json()
        assert line["via"] == "next_turn" and line["at"], line
        again = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), {"via": "turn"})  # a retry / a later report
        assert again.status_code == 200 and (again.json().get("data") or again.json()) == line, again.text  # nothing is rewritten
        assert (await _read(Session, w, w.r_human, msg))["delivery_log"] == {str(w.g_p): line}
        # the body names only the word: a time of the host's own is refused, not stored
        bad = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), {"via": "turn", "at": "2020-01-01T00:00:00+00:00"})
        assert bad.status_code == 422, bad.text
    finally:
        await engine.dispose()


async def test_only_a_recipient_agent_can_report_everyone_else_gets_the_same_answer():
    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human)
        answers = []
        # g_2 is an agent of the organization that is NOT in this room · a missing message · the message in the WRONG room (r_agents has g_p but this message is not there)
        answers.append(await _as(Session, w, "agent_plain", "POST", _report(w.r_human, msg), {"via": "turn"}))
        answers.append(await _as(Session, w, "agent_participant", "POST", _report(w.r_human, uuid.uuid4()), {"via": "turn"}))
        answers.append(await _as(Session, w, "agent_participant", "POST", _report(w.r_agents, msg), {"via": "turn"}))
        assert [a.status_code for a in answers] == [404, 404, 404] and len({a.text for a in answers}) == 1, [(a.status_code, a.text) for a in answers]
        for person in ("participant", "org_owner", "member_outside"):
            r = await _as(Session, w, person, "POST", _report(w.r_human, msg), {"via": "turn"})
            assert r.status_code == 403, (person, r.text)  # agents only
        assert "delivery_log" not in await _read(Session, w, w.r_human, msg)
    finally:
        await engine.dispose()


async def test_a_via_outside_the_two_words_is_refused():
    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human)
        for bad in ({"via": "now"}, {"via": ""}, {}, {"via": ["turn"]}):
            r = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), bad)
            assert r.status_code == 422, (bad, r.text)
    finally:
        await engine.dispose()


async def test_two_reports_at_once_leave_exactly_one_line_and_both_get_the_same_answer():
    from app.main import app
    from tests.test_4846_org_chat_rooms_realdb import _client_for, _setup_app_agent

    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human)
        await _setup_app_agent(app, Session, w.g_p, w.org)
        try:
            async with _client_for(app) as c:
                a, b = await asyncio.gather(c.post(_report(w.r_human, msg), json={"via": "turn"}), c.post(_report(w.r_human, msg), json={"via": "next_turn"}))
        finally:
            app.dependency_overrides.clear()
        assert a.status_code == b.status_code == 200, (a.text, b.text)
        assert (a.json().get("data") or a.json()) == (b.json().get("data") or b.json())  # one line won; the other got it back
        assert list((await _read(Session, w, w.r_human, msg))["delivery_log"]) == [str(w.g_p)]
    finally:
        await engine.dispose()


async def test_a_report_rewrites_nothing_else_in_the_messages_metadata():
    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human, delivery_mode="after_turn")
        async with Session() as s:  # keys other namespaces write (a card · an approval · the withheld count) must survive the report untouched
            await s.execute(text("UPDATE conversation_messages SET metadata = metadata || CAST(:extra AS jsonb) WHERE id = :m"), {"m": msg, "extra": json.dumps({"approval_target": {"gate_id": "g1"}, "card": {"kind": "story", "ref": "0d6e953f-6d43-42c1-a87c-b023544497db"}})})
            await s.commit()
        r = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), {"via": "turn"})
        assert r.status_code == 200, r.text
        async with Session() as s:
            meta = (await s.execute(text("SELECT metadata FROM conversation_messages WHERE id = :m"), {"m": msg})).scalar_one()
        meta = meta if isinstance(meta, dict) else json.loads(meta)
        assert meta["approval_target"] == {"gate_id": "g1"} and meta["card"]["kind"] == "story", meta
        assert meta["delivery"]["mode"] == "after_turn" and list(meta["delivery_log"]) == [str(w.g_p)], meta
    finally:
        await engine.dispose()


async def test_a_plain_message_with_no_metadata_at_all_can_be_reported():
    """the common case: a message sent the old way holds a JSON null as its metadata (not an object) — the report must still make the line (found by the concurrent-reports test: `jsonb_set` cannot set a path in a scalar)"""
    engine, Session, w = await _world()
    try:
        _r, msg = await _send(Session, w, w.r_human)
        async with Session() as s:
            kind = (await s.execute(text("SELECT jsonb_typeof(metadata) FROM conversation_messages WHERE id = :m"), {"m": msg})).scalar_one_or_none()
        assert kind in (None, "null"), kind  # a message with no metadata of its own
        r = await _as(Session, w, "agent_participant", "POST", _report(w.r_human, msg), {"via": "turn"})
        assert r.status_code == 200, r.text
        assert list((await _read(Session, w, w.r_human, msg))["delivery_log"]) == [str(w.g_p)]
    finally:
        await engine.dispose()
