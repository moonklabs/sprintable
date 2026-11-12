"""story #4903 AC1 — the words of a deleted message are removed from the copies the server stored of it.

The delete (#2319) tombstones the message row (`content = ""`), but a message is copied when it is sent:
- one `events` row per recipient (`payload` carries `content`, `summary`, `attachments` — a new stream connection backfills the last few events, so
  a reload put the deleted words back into the room list's row);
- one `notifications` row per person who was mentioned or told about it (`body` is a preview made at send time; the row has no link to the message,
  only `reference_id = conversation_id`).

Both are scrubbed here, in the delete's own transaction (the caller commits). The rows stay — the bell and the backfill still know a message
existed — only the words go. A push or a webhook already delivered is outside the server and cannot be taken back.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.notification import Notification
from app.services.text_preview import NOTIFICATION_BODY_PREVIEW_MAX, plain_text_preview

# a notification row is made in the request that created the message: its clock is the message's, give or take the request's own duration
NOTIFICATION_MATCH_WINDOW = timedelta(seconds=60)

# the words a stored event payload carries, and what each is left as (only a key that is there is touched)
_EVENT_PAYLOAD_SCRUBBED_KEYS: dict[str, Any] = {"content": "", "attachments": []}


async def scrub_stored_copies_of_deleted_message(
    db: AsyncSession,
    *,
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    created_at: datetime,
    old_content: str | None,
    summary_without_words: str,
) -> dict[str, int]:
    """remove the deleted message's words from its event rows and its notification rows; returns how many of each were scrubbed.

    `old_content` is the content as it was BEFORE the tombstone (the notification body is matched against its preview: the row carries no message
    id). `summary_without_words` is what the event `summary` becomes («sender» alone). Caller: the delete route, inside its transaction."""
    scrubbed_events = 0
    events = (await db.execute(
        select(Event).where(Event.source_entity_type == "conversation_message", Event.source_entity_id == message_id)
    )).scalars().all()
    for event in events:
        payload = dict(event.payload or {})
        changed = False
        for key, left in _EVENT_PAYLOAD_SCRUBBED_KEYS.items():
            if key in payload and payload[key] != left:
                payload[key] = left
                changed = True
        if "summary" in payload and payload["summary"] != summary_without_words:
            payload["summary"] = summary_without_words
            changed = True
        if changed:
            event.payload = payload  # a new dict: the JSONB column notices the change
            scrubbed_events += 1

    scrubbed_notifications = 0
    preview = plain_text_preview(old_content, NOTIFICATION_BODY_PREVIEW_MAX)
    if preview:  # an empty preview carried no words
        rows = (await db.execute(
            select(Notification).where(
                Notification.reference_type == "conversation",
                Notification.reference_id == conversation_id,
                Notification.body == preview,
                Notification.created_at >= created_at - NOTIFICATION_MATCH_WINDOW,
                Notification.created_at <= created_at + NOTIFICATION_MATCH_WINDOW,
            )
        )).scalars().all()
        for row in rows:
            row.body = None
            event = row.event if isinstance(row.event, dict) else None
            if event:
                # the card of an ordinary message is only `sender_name`; anything else on it was copied from the message
                row.event = {"sender_name": event["sender_name"]} if "sender_name" in event else None
            scrubbed_notifications += 1
    await db.flush()
    return {"events": scrubbed_events, "notifications": scrubbed_notifications}
