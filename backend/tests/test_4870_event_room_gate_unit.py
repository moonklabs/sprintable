"""story #4870 — the pure parts of `services/event_room_gate.py`: which stored copies carry a room's words (and which room), and the shape the words are withheld in.
The roads that use it are pinned on a real database in test_4870_event_reread_room_gate_realdb.py."""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from app.services.event_room_gate import (
    MENTION_WITHOUT_TEXT_KEYS,
    StoredEvent,
    payload_without_room_words,
    room_of,
    stored_event,
    withheld_payloads,
)

ROOM = uuid.uuid4()
ME = uuid.uuid4()


def _item(event_type, *, payload=None, source_type=None, source_id=None, key="k"):
    return StoredEvent(key=key, event_type=event_type, source_entity_type=source_type, source_entity_id=source_id, payload=payload, recipient_id=ME)


@pytest.mark.parametrize("event_type", ["conversation.message_created", "conversation:mention", "conversation.human_intervention_requested", "a2a.task_message"])
def test_a_chat_kind_names_its_room_in_the_payload(event_type):
    assert room_of(_item(event_type, payload={"conversation_id": str(ROOM)})) == ROOM


def test_the_bell_event_about_a_room_names_the_room_by_its_source():
    assert room_of(_item("dispatched", source_type="conversation", source_id=ROOM, payload={"body": "x"})) == ROOM
    assert room_of(_item("dispatched", source_type="conversation", source_id=str(ROOM))) == ROOM


@pytest.mark.parametrize(
    "item",
    [
        _item("dispatched", source_type="story", source_id=ROOM, payload={"body": "x"}),               # a bell about a story
        _item("dispatched", source_type="conversation_message", source_id=ROOM, payload={"body": "x"}),   # not the room's id: cannot be judged as a room
        _item("story_assigned", payload={"conversation_id": str(ROOM), "content": "x"}),                # another kind of event, whatever it holds
        _item("conversation.read", payload={"conversation_id": str(ROOM)}),
        _item("conversation.gate_created", payload={"target_conversation_id": str(ROOM)}),
    ],
)
def test_every_other_kind_of_event_carries_no_room_words(item):
    assert room_of(item) is None


@pytest.mark.parametrize("bad", [None, "", "not-a-uuid", 12, {"a": 1}])
def test_a_room_that_cannot_be_read_from_the_payload_is_not_a_room(bad):
    assert room_of(_item("conversation.message_created", payload={"conversation_id": bad})) is None
    assert room_of(_item("conversation.message_created", payload=None)) is None
    assert room_of(_item("conversation.message_created", payload={})) is None


@pytest.mark.anyio
@pytest.mark.parametrize("bad", [None, "", "not-a-uuid", 12])
@pytest.mark.parametrize("event_type", ["conversation.message_created", "conversation:mention", "conversation.human_intervention_requested", "a2a.task_message"])
async def test_a_copy_of_a_rooms_words_whose_room_cannot_be_named_is_withheld_not_passed(event_type, bad):
    """fail closed (codex): the room cannot be named → nobody can be shown to read it → the words go, and the database is not asked."""
    class _NoDb:
        async def execute(self, *a, **k):  # pragma: no cover — must not be reached
            raise AssertionError("nothing to ask: no room to look up")

    item = _item(event_type, payload={"conversation_id": bad, "content": "the words"}, key="u")
    out = await withheld_payloads(_NoDb(), uuid.uuid4(), SimpleNamespace(), [item])
    assert set(out) == {"u"} and out["u"]["content"] == "" and out["u"]["content_withheld"] is True and "the words" not in repr(out)


@pytest.mark.anyio
async def test_a_bell_event_about_a_room_with_no_readable_source_is_withheld_with_its_title_as_content():
    class _NoDb:
        async def execute(self, *a, **k):  # pragma: no cover
            raise AssertionError("nothing to ask")

    item = _item("dispatched", source_type="conversation", source_id=None, payload={"title": "a new message", "body": "preview words", "event_type": "conversation.message"}, key="b")
    out = await withheld_payloads(_NoDb(), uuid.uuid4(), SimpleNamespace(), [item])
    assert out["b"] == {"title": "a new message", "event_type": "conversation.message", "body": "", "content": "a new message", "content_withheld": True}   # agent adapters need a non-empty `content` (#2375)


def _message_payload():
    return {
        "id": "m1", "conversation_id": str(ROOM), "thread_id": None, "reply_count": 2, "content": "the words", "summary": "A: the words", "mentioned_ids": ["x"],
        "attachments": [{"name": "secret.txt"}], "sender_org_id": "o1", "sender": {"id": "s", "name": "A"}, "created_at": "t", "references": [{"a": 1}], "audience": "x", "brand_new_key": "words too",
    }


def test_withheld_chat_payload_keeps_only_the_closed_list_and_marks_it():
    out = payload_without_room_words(_message_payload(), recipient_id=ME, mention=True)
    assert set(out) == set(MENTION_WITHOUT_TEXT_KEYS) | {"content", "attachments", "mentioned_ids", "content_withheld"}
    assert out["content"] == "" and out["attachments"] == [] and out["content_withheld"] is True and out["mentioned_ids"] == [str(ME)]
    assert "the words" not in repr(out) and "secret.txt" not in repr(out) and "words too" not in repr(out)        # a key added to the message payload later does not travel either


def test_a_message_that_is_not_a_mention_does_not_say_it_named_the_recipient():
    out = payload_without_room_words(_message_payload(), recipient_id=ME, mention=False)
    assert out["mentioned_ids"] == [] and out["content_withheld"] is True


def test_the_payload_given_is_not_changed():
    p = _message_payload()
    before = dict(p)
    payload_without_room_words(p, recipient_id=ME)
    assert p == before


@pytest.mark.anyio
async def test_nothing_to_ask_when_no_item_carries_a_room_the_database_is_not_asked():
    class _NoDb:
        async def execute(self, *a, **k):  # pragma: no cover — must not be reached
            raise AssertionError("the database must not be asked when no copy carries a room's words")

    items = [_item("story_assigned", payload={"title": "t"}, key="a"), _item("dispatched", source_type="story", source_id=ROOM, key="b")]
    assert await withheld_payloads(_NoDb(), uuid.uuid4(), SimpleNamespace(), items) == {}
    assert await withheld_payloads(_NoDb(), uuid.uuid4(), SimpleNamespace(), []) == {}


def test_stored_event_reads_an_orm_like_row():
    row = SimpleNamespace(id=uuid.uuid4(), event_type="dispatched", source_entity_type="conversation", source_entity_id=ROOM, payload={"body": "b"}, recipient_id=ME)
    it = stored_event(row)
    assert it.key == str(row.id) and room_of(it) == ROOM
    assert stored_event(row, key="custom").key == "custom"


@pytest.fixture
def anyio_backend():
    return "asyncio"
