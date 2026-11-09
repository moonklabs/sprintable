"""story #4870 — the room-read gate of the roads that READ AN ALREADY-STORED event copy back.

4846 (AC12 / AC14) made «reading a room» ONE predicate (`conversation_auth.conversation_readable_predicate`) and cut what is SENT: an agent that has not a room's
project is no longer delivered the room's words. A copy that was stored while the agent HAD the project is another matter: the roads that read an `events` row back — the bell list and its
mark-read, `/events/pending`, `/events/{id}/delivered`, the reconnect backfill of `/events/stream`, and the agent gateway's replay (`/agent/stream`) — asked for recipient + organization only, so
an agent that lost the project (or a person who left the room) still got the words of the room from a copy it had been sent. «Reading stops when the project is taken away» (AC12) has to hold for
the copy too.

The rule, in ONE place: before such a road hands a room's words back it asks «may this caller read this room NOW» (`readable_room_clause`, the same predicate every read uses) and, if not, the words
are taken OUT of the copy that is handed back — the row is kept, and the shape is the one a mention of someone outside the room already has (AC9): the bell and who/where, never the words
(`content_withheld`). A PERSON is asked the same question as everyone (participant, or the admin rule), and the project is not part of it for a person: a person who lost the project but is
still in the room reads on.

Nothing here writes: the stored row is never changed (a stored copy altered in the session would be written back by the next commit — the delivery stamp of the same road). The roads get a
replacement payload to use for the response or the frame, keyed by their own key for the row.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Iterable

from sqlalchemy import select

# the stored event kinds that carry a room's WORDS, and where the room is named
CHAT_MESSAGE_EVENT_TYPES = frozenset({
    "conversation.message_created",
    "conversation:mention",
    "conversation.human_intervention_requested",
})
A2A_TASK_MESSAGE = "a2a.task_message"
BELL_EVENT_TYPE = "dispatched"
BELL_ROOM_SOURCE = "conversation"

# What a chat-message copy keeps when its words are withheld: that somebody wrote, where, and who — never the words. A closed list (anything not named here is dropped, so a field added to the
# message payload later does not start to travel to someone who cannot read it). The same list as a mention of a person outside the room (4846 AC9) — see `routers/conversations.py`.
MENTION_WITHOUT_TEXT_KEYS = ("id", "conversation_id", "created_at", "sender_org_id", "sender")
_A2A_KEPT_KEYS = ("message_id", "conversation_id")
_BELL_KEPT_KEYS = ("title", "event_type")


def payload_without_room_words(payload: dict, *, recipient_id: "uuid.UUID | str | None" = None, mention: bool = True) -> dict:
    """a chat message's payload without its words: the closed list of ids and the sender stays; `content` is empty, no attachments, `content_withheld` is set. `mention` keeps the recipient as the
    one named (what a mention of a person outside the room has always carried)."""
    out = {k: payload[k] for k in MENTION_WITHOUT_TEXT_KEYS if k in payload}
    out.update(content="", attachments=[], mentioned_ids=[str(recipient_id)] if (mention and recipient_id is not None) else [], content_withheld=True)
    return out


def _uuid_or_none(value: Any) -> "uuid.UUID | None":
    if value is None:
        return None
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


@dataclass(frozen=True)
class StoredEvent:
    """what the gate needs to know about one stored row — read from an ORM `Event` or a raw gateway row alike; `key` is what the caller finds the row by."""

    key: str
    event_type: str
    source_entity_type: "str | None"
    source_entity_id: Any
    payload: "dict | None"
    recipient_id: Any


def carries_room_words(item: StoredEvent) -> bool:
    """does this stored copy carry a room's words — by its KIND (chat message kinds, the a2a task message, the bell event about a room), whether or not the room can be named."""
    if item.event_type in CHAT_MESSAGE_EVENT_TYPES or item.event_type == A2A_TASK_MESSAGE:
        return True
    return item.event_type == BELL_EVENT_TYPE and item.source_entity_type == BELL_ROOM_SOURCE


def room_of(item: StoredEvent) -> "uuid.UUID | None":
    """the room a stored copy's words belong to, or None when it cannot be named (the payload / source names no room, or a malformed one) or the event carries no room's words at all."""
    payload = item.payload if isinstance(item.payload, dict) else {}
    if item.event_type in CHAT_MESSAGE_EVENT_TYPES or item.event_type == A2A_TASK_MESSAGE:
        return _uuid_or_none(payload.get("conversation_id"))
    if item.event_type == BELL_EVENT_TYPE and item.source_entity_type == BELL_ROOM_SOURCE:
        return _uuid_or_none(item.source_entity_id)
    return None


def _withheld(item: StoredEvent) -> dict:
    payload = item.payload if isinstance(item.payload, dict) else {}
    if item.event_type in CHAT_MESSAGE_EVENT_TYPES:
        return payload_without_room_words(payload, recipient_id=item.recipient_id, mention=item.event_type == "conversation:mention")
    if item.event_type == A2A_TASK_MESSAGE:
        return {**{k: payload[k] for k in _A2A_KEPT_KEYS if k in payload}, "content": "", "content_withheld": True}
    # `content` stays a non-empty string: the agent adapters drop a bell event that lacks it (#2375) — it is the title (what the bell says without the preview), never the preview
    return {**{k: payload[k] for k in _BELL_KEPT_KEYS if k in payload}, "body": "", "content": str(payload.get("title") or ""), "content_withheld": True}


async def readable_conversation_ids(db, org_id: uuid.UUID, auth, conversation_ids: "set[uuid.UUID]") -> "set[uuid.UUID]":
    """of these rooms, the ones this caller may read NOW — one statement, the clause every other read uses. A caller who cannot be resolved reads no room; a room that is gone is not readable."""
    if not conversation_ids:
        return set()
    from app.models.conversation import Conversation
    from app.services.conversation_auth import readable_room_clause

    clause = await readable_room_clause(db, org_id, auth)
    rows = await db.execute(select(Conversation.id).where(Conversation.org_id == org_id, Conversation.id.in_(conversation_ids), clause))
    return {r[0] for r in rows.all()}


async def withheld_payloads(db, org_id: uuid.UUID, auth, items: "Iterable[StoredEvent]") -> "dict[str, dict]":
    """`key → the payload to hand back INSTEAD` for the stored copies whose room this caller may not read now. Rows that carry no room's words, and rows whose room the caller may read, are not in the
    answer (the road uses what it already has). One question to the database for the whole batch."""
    rooms: dict[str, uuid.UUID] = {}
    by_key: dict[str, StoredEvent] = {}
    unnamed: list[StoredEvent] = []
    for it in items:
        if not carries_room_words(it):
            continue
        by_key[it.key] = it
        room = room_of(it)
        if room is None:
            unnamed.append(it)  # fail closed: a copy of a room's words whose room cannot be named is a room nobody can be shown to read
        else:
            rooms[it.key] = room
    out: dict[str, dict] = {it.key: _withheld(it) for it in unnamed}
    if not rooms:
        return out
    readable = await readable_conversation_ids(db, org_id, auth, set(rooms.values()))
    out.update({key: _withheld(by_key[key]) for key, room in rooms.items() if room not in readable})
    return out


async def withhold_room_preview(db, org_id: uuid.UUID, auth, event_context: Any) -> dict:
    """story #4870 AC5 — the workflow execution log keeps the first 200 characters of the message that triggered a rule (`event_context.metadata.content_preview`, with its `conversation_id`).
    The log's detail is read by an organization owner/admin from outside the room, and by the canonical room-read rule an owner/admin does NOT read a room that has a person in it (the bypass
    is for rooms of agents only) — so the preview is a copy of a room's words and gets the same question as every stored copy: may this caller read this room NOW? If not (or the room cannot be
    named), the preview is taken out and the log says so; everything else in the log is unchanged. The stored row is never changed."""
    ctx = event_context if isinstance(event_context, dict) else {}
    meta = ctx.get("metadata")
    if not isinstance(meta, dict) or "content_preview" not in meta:
        return ctx
    room = _uuid_or_none(meta.get("conversation_id"))
    if room is not None and room in await readable_conversation_ids(db, org_id, auth, {room}):
        return ctx
    return {**ctx, "metadata": {**meta, "content_preview": "", "content_withheld": True}}


# ─── story #4875 — the person's side: a `notifications` row ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
# A message that mentions a person (`conversation.mention`) or is sent in a room they are in (`conversation.message`) leaves a notification row whose `body` is a preview of the message and whose `event`
# can carry the message's own payload (the card). Those two kinds are the notification copies of a room's words; every other kind that points at a conversation (the circuit-breaker notice, a
# computer's turn-ended notice) says a sentence of its own and is left as it is.
NOTIFICATION_ROOM_WORD_TYPES = frozenset({"conversation.mention", "conversation.message"})
_NOTIFICATION_EVENT_KEPT_KEYS = ("sender_name",)


def notification_carries_room_words(n: dict) -> bool:
    """does this notification (as a dict: type, body, event, reference_*) hold a room's words — by its KIND, and only when it holds any: a bare mention (no preview, an event of only the sender's name)
    has nothing to take out."""
    if n.get("type") not in NOTIFICATION_ROOM_WORD_TYPES:
        return False
    event = n.get("event")
    if event is not None and not isinstance(event, dict):
        return True   # an event of a shape nobody writes (a list, a scalar): it cannot be shown to hold no words, so it is treated as holding them
    return bool(n.get("body")) or (isinstance(event, dict) and any(k not in _NOTIFICATION_EVENT_KEPT_KEYS and k != "content_withheld" for k in event))


def notification_without_room_words(n: dict) -> dict:
    """the same notification without its words: no preview, and an event that keeps only who wrote (`sender_name`) plus `content_withheld` (the closed list — a field added to the event later does not
    start to travel). The row, its title and its read state are untouched."""
    event = n.get("event") if isinstance(n.get("event"), dict) else {}
    kept = {k: event[k] for k in _NOTIFICATION_EVENT_KEPT_KEYS if k in event}
    return {**n, "body": None, "event": {**kept, "content_withheld": True}}


async def withhold_notification_room_words(db, org_id: uuid.UUID, auth, items: "list[dict]") -> "list[dict]":
    """story #4875 — before a road hands notification rows back (the list, the single read), ask once for the whole batch «may this caller read the room NOW» and take the words out of the copies
    whose room they may not read — or whose room cannot be named (fail closed). Same question as every stored copy: the room-read predicate; a PERSON is not cut by project (4846 AC2) — one who
    lost the project but is still in the room reads on. Nothing is written: the ORM row is not touched (the caller builds the replacement from its own dump)."""
    rooms: dict[int, "uuid.UUID | None"] = {}
    for i, n in enumerate(items):
        if notification_carries_room_words(n):
            rooms[i] = _uuid_or_none(n.get("reference_id")) if n.get("reference_type") == "conversation" else None
    if not rooms:
        return items
    readable = await readable_conversation_ids(db, org_id, auth, {r for r in rooms.values() if r is not None})
    out = list(items)
    for i, room in rooms.items():
        if room is None or room not in readable:
            out[i] = notification_without_room_words(items[i])
    return out


def stored_event(row: Any, *, key: "str | None" = None) -> StoredEvent:
    """an ORM `Event` (or any object with its columns) as the gate's view of it."""
    return StoredEvent(
        key=key if key is not None else str(row.id),
        event_type=row.event_type,
        source_entity_type=getattr(row, "source_entity_type", None),
        source_entity_id=getattr(row, "source_entity_id", None),
        payload=getattr(row, "payload", None),
        recipient_id=getattr(row, "recipient_id", None),
    )
