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
@pytest.mark.parametrize("row", [_n("story_assigned", "story"), _n("chain.expired", "conversation"), _n("desktop.turn_ended", "conversation"), _n("comment.created", "story")])
async def test_a_row_of_another_kind_is_not_asked_about(row):
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


@pytest.mark.anyio
@pytest.mark.parametrize("ref_type,ref_id", [(None, None), ("story", ROOM), ("conversation", None), ("conversation", "not-a-uuid")])
@pytest.mark.parametrize("kind", ["conversation.message", "conversation.mention"])
async def test_a_row_of_the_two_kinds_whose_reference_is_not_a_room_is_withheld_by_kind(kind, ref_type, ref_id):
    """digi's cell: the kind alone makes a row a copy of a room's words — a missing or non-room reference cannot name its room, so nobody can be shown to read it."""
    row = _n(kind, ref_type, ref_id, event={"sender_name": "A", "payload": {"words": "x"}})
    assert await room_notifications_to_withhold(_NoDb(), uuid.uuid4(), SimpleNamespace(), [row]) == {row.id: {"sender_name": "A"}}


@pytest.mark.anyio
@pytest.mark.parametrize("ev", [None, [], ["words"], "words", 7, {"payload": {"words": "x"}}, {"sender_name": ["words"]}, {"sender_name": {"w": "x"}}, {"sender_name": 5}, {"sender_name": ""}])
async def test_an_event_of_any_other_shape_is_dropped_only_a_plain_sender_name_survives(ev):
    row = _n(ref_id=None, event=ev)
    assert await room_notifications_to_withhold(_NoDb(), uuid.uuid4(), SimpleNamespace(), [row]) == {row.id: None}
