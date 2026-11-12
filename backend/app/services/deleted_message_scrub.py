"""story #4903 AC1 — the words of a deleted message are removed from the copies the server stored of it.

The delete (#2319) tombstones the message row (`content = ""`), but a message is copied when it is sent:
- `events` rows — one `conversation.message_created` row per recipient (`payload`: `content`, `summary`, `attachments`, signed image URLs `images`, the cards in
  `msg_metadata`) that a new stream connection backfills (the last few, pending + delivered in the last 300 s), and one `dispatched` bell row per person told about
  it (`payload.body` is a preview);
- `activity_events` rows — the activity stream's copy of those event payloads;
- `notifications` rows — `body` is a preview made at send time; since #4903 the card (`event`) names the message — `event.message_id`;
- `delivery_jobs` rows — the outbox of a push / personal webhook (`payload.body` is the preview; a job still pending would deliver the words after the delete).

All of them are scrubbed here, in the delete's own transaction (the caller commits). The rows stay — the bell and the backfill still know a message existed — only the
words go. A row made since #4903 names its message and is found by that id; a row made BEFORE it has no id and is found only by room · moment · preview (never a row that
names a message). A push or a webhook already delivered is outside the server and cannot be taken back; the proof snapshots a story took of a message on purpose
(`entity_references.proof_payload`) are that author's evidence, not a delivery copy — left as they are (a product decision, see the story).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity_event import ActivityEvent
from app.models.delivery_job import DeliveryJob
from app.models.event import Event
from app.models.notification import Notification
from app.services.text_preview import NOTIFICATION_BODY_PREVIEW_MAX, plain_text_preview

# a copy is made in the request that created the message: its clock is the message's, give or take the request's own duration
MATCH_WINDOW = timedelta(seconds=60)
# the notification types a chat message makes (an old-form row is matched among these only — another kind of notification can share the room id)
CONVERSATION_NOTIFICATION_TYPES = ("conversation.mention", "conversation.message")

# what a stored message payload (an event / activity row) is left as — only a key that is there and not already so is touched
_PAYLOAD_EMPTIED: dict[str, Any] = {"content": "", "attachments": [], "images": [], "event": None, "approval_target": None, "server_command": None}


def _scrubbed_message_payload(payload: dict | None, summary: str) -> dict | None:
    """the payload with the words taken out, or None when there was nothing to take out"""
    if not isinstance(payload, dict):
        return None
    out = dict(payload)
    changed = False
    for key, left in _PAYLOAD_EMPTIED.items():
        if key in out and out[key] != left:
            out[key] = left
            changed = True
    if "summary" in out and out["summary"] != summary:
        out["summary"] = summary
        changed = True
    return out if changed else None


def _scrubbed_body(payload: dict | None) -> dict | None:
    if isinstance(payload, dict) and payload.get("body") is not None:
        return {**payload, "body": None}
    return None


async def scrub_stored_copies_of_deleted_message(
    db: AsyncSession,
    *,
    message_id: uuid.UUID,
    conversation_id: uuid.UUID,
    created_at: datetime,
    old_content: str | None,
    summary_without_words: str,
) -> dict[str, int]:
    """remove the deleted message's words from its stored copies; returns how many rows of each kind were scrubbed.

    `old_content` is the content as it was BEFORE the tombstone, or None on a repeat delete (the old-form match needs the words, so a repeat delete runs the id-based
    part only). `summary_without_words` is what an event `summary` becomes («sender» alone). Caller: the delete route, inside its transaction."""
    mid = str(message_id)
    preview = plain_text_preview(old_content, NOTIFICATION_BODY_PREVIEW_MAX) if old_content else ""
    window = (created_at - MATCH_WINDOW, created_at + MATCH_WINDOW)
    counts = {"events": 0, "bell_events": 0, "activity_events": 0, "notifications": 0, "delivery_jobs": 0}

    # (1) the message_created event rows, found by the message they copy
    for event in (await db.execute(
        select(Event).where(Event.source_entity_type == "conversation_message", Event.source_entity_id == message_id)
    )).scalars().all():
        new = _scrubbed_message_payload(event.payload, summary_without_words)
        if new is not None:
            event.payload = new  # a new dict: the JSONB column notices the change
            counts["events"] += 1

    # (2) the dispatched bell rows: by the id they carry (a row made since #4903), else — an OLD row only — by room · moment · preview
    bell_where = [Event.event_type == "dispatched", Event.source_entity_type == "conversation", Event.source_entity_id == conversation_id]
    bells = list((await db.execute(select(Event).where(*bell_where, Event.payload["message_id"].as_string() == mid))).scalars().all())
    if preview:
        bells += list((await db.execute(
            select(Event).where(
                *bell_where,
                Event.payload["message_id"].as_string().is_(None),
                Event.payload["body"].as_string() == preview,
                Event.payload["event_type"].as_string().in_(CONVERSATION_NOTIFICATION_TYPES),
                Event.created_at >= window[0], Event.created_at <= window[1],
            )
        )).scalars().all())
    bell_ids = []
    for event in bells:
        bell_ids.append(event.id)
        new = _scrubbed_body(event.payload)
        if new is not None:
            event.payload = new
            counts["bell_events"] += 1

    # (3) the activity stream's copies: of the message's own events (object = the message), and of the bell rows scrubbed above (they name them in `source_event_ids`)
    for activity in (await db.execute(
        select(ActivityEvent).where(ActivityEvent.object_type == "conversation_message", ActivityEvent.object_id == message_id)
    )).scalars().all():
        new = _scrubbed_message_payload(activity.payload, summary_without_words)
        if new is not None:
            activity.payload = new
            counts["activity_events"] += 1
    if bell_ids:
        for activity in (await db.execute(select(ActivityEvent).where(ActivityEvent.source_event_ids.overlap(bell_ids)))).scalars().all():
            new = _scrubbed_body(activity.payload)
            if new is not None:
                activity.payload = new
                counts["activity_events"] += 1

    # (4) the notification rows
    note_where = [Notification.reference_type == "conversation", Notification.reference_id == conversation_id]
    notes = list((await db.execute(select(Notification).where(*note_where, Notification.event["message_id"].as_string() == mid))).scalars().all())
    if preview:
        notes += list((await db.execute(
            select(Notification).where(
                *note_where,
                Notification.type.in_(CONVERSATION_NOTIFICATION_TYPES),
                Notification.body == preview,
                or_(Notification.event.is_(None), Notification.event["message_id"].as_string().is_(None)),
                Notification.created_at >= window[0], Notification.created_at <= window[1],
            )
        )).scalars().all())
    for row in notes:
        row.body = None
        event = row.event if isinstance(row.event, dict) else None
        if event:
            # the card of an ordinary message is only `sender_name` (+ the message id); anything else on it was copied from the message
            row.event = {"sender_name": event["sender_name"]} if "sender_name" in event else None
        counts["notifications"] += 1

    # (5) the outbox: a push / personal-webhook job that has not gone out yet would still carry the words
    job_where = [DeliveryJob.kind == "personal_webhook"]
    jobs = list((await db.execute(select(DeliveryJob).where(*job_where, DeliveryJob.payload["message_id"].as_string() == mid))).scalars().all())
    if preview:
        jobs += list((await db.execute(
            select(DeliveryJob).where(
                *job_where,
                DeliveryJob.payload["reference_id"].as_string() == str(conversation_id),
                DeliveryJob.payload["message_id"].as_string().is_(None),
                DeliveryJob.payload["body"].as_string() == preview,
                DeliveryJob.created_at >= window[0], DeliveryJob.created_at <= window[1],
            )
        )).scalars().all())
    for job in jobs:
        new = _scrubbed_body(job.payload)
        if new is not None:
            job.payload = new
            counts["delivery_jobs"] += 1

    await db.flush()
    return counts
