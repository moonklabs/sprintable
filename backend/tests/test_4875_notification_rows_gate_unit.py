"""story #4875 — the pure parts of `services/event_room_gate.room_notifications_to_withhold`: which rows are about a room's words, what is kept, and that the database is not asked when it has nothing to ask."""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.services.event_room_gate import NOTIFICATION_ROOM_TYPES, room_notifications_to_withhold

ROOM = uuid.uuid4()


class _NoDb:
    async def execute(self, *a, **k):  # pragma: no cover — must not be reached
        raise AssertionError("the database must not be asked: there is no room to look up")


def _n(type_="conversation.message", ref_type="conversation", ref_id=ROOM, event=None):
    return SimpleNamespace(id=uuid.uuid4(), type=type_, reference_type=ref_type, reference_id=ref_id, event=event)


def test_the_two_kinds_that_carry_a_rooms_words():
    assert NOTIFICATION_ROOM_TYPES == {"conversation.message", "conversation.mention"}


@pytest.mark.anyio
@pytest.mark.parametrize("row", [_n("story_assigned", "story"), _n("conversation.message", "story"), _n("chain.expired", "conversation"), _n("conversation.mention", None, None)])
async def test_a_row_that_is_not_about_a_rooms_words_is_not_asked_about(row):
    assert await room_notifications_to_withhold(_NoDb(), uuid.uuid4(), SimpleNamespace(), [row]) == {}
    assert await room_notifications_to_withhold(_NoDb(), uuid.uuid4(), SimpleNamespace(), []) == {}


@pytest.mark.anyio
@pytest.mark.parametrize("bad", [None, "", "not-a-uuid", 12])
async def test_a_room_row_that_names_no_usable_room_is_withheld_and_nothing_is_asked(bad):
    """fail closed: the room cannot be named, so nobody can be shown to read it."""
    kept = _n(ref_id=bad, event={"sender_name": "A", "payload": {"words": "x"}})
    bare = _n(ref_id=bad, event=None)
    out = await room_notifications_to_withhold(_NoDb(), uuid.uuid4(), SimpleNamespace(), [kept, bare])
    assert out == {kept.id: {"sender_name": "A"}, bare.id: None}


@pytest.fixture
def anyio_backend():
    return "asyncio"
