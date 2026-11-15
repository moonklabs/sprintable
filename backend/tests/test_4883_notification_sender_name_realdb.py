"""story #4883 — the sender cannot rename itself in the notification a message leaves for others.

A message that is sent with `event_context` (the card of an event-publishing message: `event_key`, `payload`, `refs`) leaves its recipients a `notifications` row whose `event` is the card WITH the
sender's name added. The name was written FIRST and the sender's own `event_context` was merged after it (`{"sender_name": <server's>, **event_context}`), so a sender who put `sender_name` in its
`event_context` replaced the name the server had worked out — and 4875's withheld copy («the sender's name only») kept that forged name for a person who may no longer read the room. Reproduced first
(red on develop, the dev measurement is in the PR), then green: the server's name is written LAST; every other key of the card is as the sender sent it.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_4846_ac14_room_reads_realdb import _as
from tests.test_4846_org_chat_rooms_realdb import (  # noqa: F401 — fixtures used by name
    _REAL_DB_URL,
    _dispose_global_engine_after_test,
    _world,
)
from tests.test_4875_notification_rows_room_gate_realdb import _leave, _list, _rows_of

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

FORGED = "forged-name-4883"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _send(Session, w, content, *, mention=None, event_context=None):
    if event_context is not None:
        # story 4894: a card cannot be sent to the public route any more; the server's own publisher sends it in-process — the same road here
        from tests._server_card import say_with_server_card

        return await say_with_server_card(Session, w, "participant", w.r_human, content, event_context=event_context, mentioned=[mention] if mention else [])
    body = {"content": content, "mentioned_ids": [str(mention)] if mention else []}
    r = await _as(Session, w, "participant", "POST", f"/api/v2/conversations/{w.r_human}/messages", body)
    assert r.status_code == 201, r.text
    return r


def _event_of(r, room, marker):
    rows = [n for n in _rows_of(r, room) if marker in str(n)]
    assert rows, f"no notification row of the room carries {marker!r}: {r.text[:400]}"
    return rows


async def _real_name(Session, w) -> str:
    """the name the server works out for the sender: read it from a plain message's notification"""
    marker = f"plain-{uuid.uuid4().hex[:8]}"
    await _send(Session, w, f"plain {marker}")
    rows = _event_of(await _list(Session, w, "lost_project"), w.r_human, marker)
    name = rows[0]["event"]["sender_name"]
    assert isinstance(name, str) and name and name != FORGED
    return name


async def test_a_message_notification_shows_the_servers_sender_name_not_the_one_in_event_context():
    engine, Session, w = await _world()
    try:
        real = await _real_name(Session, w)
        marker = f"n4883-{uuid.uuid4().hex[:8]}"
        await _send(Session, w, f"card {marker}", event_context={"event_key": "probe.k", "payload": {"summary": marker}, "refs": {"x": "y"}, "sender_name": FORGED})
        rows = _event_of(await _list(Session, w, "lost_project"), w.r_human, marker)
        assert all(n["event"]["sender_name"] == real for n in rows), [n["event"] for n in rows]
        # …and everything else of the card is as the sender sent it
        ev = rows[0]["event"]
        assert ev["event_key"] == "probe.k" and ev["payload"] == {"summary": marker} and ev["refs"] == {"x": "y"}
        # the single read hands back the same
        r = await _as(Session, w, "lost_project", "PATCH", f"/api/v2/notifications/{rows[0]['id']}/read")
        assert r.status_code == 200 and FORGED not in r.text, r.text
    finally:
        await engine.dispose()


async def test_a_mention_notification_shows_the_servers_sender_name_too():
    engine, Session, w = await _world()
    try:
        real = await _real_name(Session, w)
        marker = f"n4883m-{uuid.uuid4().hex[:8]}"
        await _send(Session, w, f"card {marker}", mention=w.h_d, event_context={"event_key": "probe.k", "payload": {"summary": marker}, "sender_name": FORGED})
        rows = [n for n in _rows_of(await _list(Session, w, "lost_project"), w.r_human) if n["type"] == "conversation.mention" and marker in str(n)]
        assert rows and all(n["event"]["sender_name"] == real for n in rows), [n["event"] for n in rows]
    finally:
        await engine.dispose()


async def test_a_sender_name_of_any_other_shape_in_event_context_does_not_get_through_either():
    engine, Session, w = await _world()
    try:
        real = await _real_name(Session, w)
        for i, odd in enumerate((["a", "b"], {"name": FORGED}, 7, None, "")):
            marker = f"n4883o{i}-{uuid.uuid4().hex[:8]}"
            await _send(Session, w, f"card {marker}", event_context={"event_key": "probe.k", "payload": {"summary": marker}, "sender_name": odd})
            rows = _event_of(await _list(Session, w, "lost_project"), w.r_human, marker)
            assert all(n["event"]["sender_name"] == real for n in rows), (odd, [n["event"] for n in rows])
    finally:
        await engine.dispose()


async def test_the_copy_withheld_from_a_person_who_left_the_room_keeps_the_servers_name_not_the_forged_one():
    engine, Session, w = await _world()
    try:
        real = await _real_name(Session, w)
        marker = f"n4883w-{uuid.uuid4().hex[:8]}"
        await _send(Session, w, f"card {marker}", event_context={"event_key": "probe.k", "payload": {"summary": marker}, "sender_name": FORGED})
        await _leave(Session, w.r_human, w.h_d)
        r = await _list(Session, w, "lost_project")
        rows = [n for n in _rows_of(r, w.r_human) if n["type"] == "conversation.message"]
        assert rows and marker not in r.text and FORGED not in r.text, "the words and the forged name are both out of the copy"
        assert all(n["event"] == {"sender_name": real} for n in rows), [n["event"] for n in rows]
    finally:
        await engine.dispose()


async def test_an_ordinary_message_without_event_context_is_as_before():
    engine, Session, w = await _world()
    try:
        real = await _real_name(Session, w)
        marker = f"n4883p-{uuid.uuid4().hex[:8]}"
        await _send(Session, w, f"plain {marker}")
        rows = _event_of(await _list(Session, w, "lost_project"), w.r_human, marker)
        # story #4903 — the card also names the message (an id, never words) so a delete can find ITS rows; the name is still the server's
        assert all(n["event"]["sender_name"] == real and set(n["event"]) == {"sender_name", "message_id"} for n in rows), [n["event"] for n in rows]
    finally:
        await engine.dispose()
