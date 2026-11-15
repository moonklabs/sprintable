"""story 4890 (found while fixing the doubled bell line · PO 11-10) — a message must not push to a person who asked not to be told about it.

`send_message_core` tells a thread's humans about a new message in two ways: the message's own `conversation.message_created` Event (the channel router leaves out whoever MUTED the conversation — preference `mute` — or is on
«mentions» without being mentioned: `preference_excluded_ids`), and, for story 1934 («every human in the thread»), `dispatch_notification("conversation.message")` — the inbox Notification, the bell's `dispatched` copy and
the push / personal-webhook outbox jobs. Its targets did not subtract `preference_excluded_ids`, nor the people who muted the room with the toggle (participant `muted_at`, the one the bell's mute rule reads). So a muted person
still got a push per message. Now the 1934 notification skips them: no outbox job names them, no inbox row, no copy.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _ee_push_on(monkeypatch):
    """the push channel (EE) is part of what 1934 sends — make it run so its outbox job exists to be looked at"""
    from app.core.config import settings

    monkeypatch.setattr(type(settings), "is_ee_enabled", property(lambda self: True), raising=False)


async def _world(conv_type="dm"):
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        sender, sender_user = await _make_human_member(s, org.id, project.id)
        reader, reader_user = await _make_human_member(s, org.id, project.id)
        other, _other_user = await _make_human_member(s, org.id, project.id)
        conv_id = await _make_conversation(s, org.id, project.id, [sender, reader, other], sender, conv_type=conv_type)
    return engine, Session, org.id, project.id, conv_id, (sender, sender_user), reader, other


async def _send(Session, org_id, user_id, conv_id, text, mentioned=()):
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": text, "mentioned_ids": [str(m) for m in mentioned]})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text


async def _told(Session, org_id, member_id):
    """what 1934's notification wrote for the person: (outbox jobs that name them, inbox rows, bell copies)"""
    from sqlalchemy import select

    from app.models.delivery_job import DeliveryJob
    from app.models.event import Event
    from app.models.member import Member
    from app.models.notification import Notification

    async with Session() as s:
        jobs = (await s.execute(select(DeliveryJob).where(DeliveryJob.org_id == org_id, DeliveryJob.kind.in_(("expo_push", "personal_webhook"))))).scalars().all()
        named = [j for j in jobs if str(member_id) in (j.payload or {}).get("member_ids", []) and (j.payload or {}).get("event_type") == "conversation.message"]
        user_id = (await s.execute(select(Member.user_id).where(Member.id == member_id))).scalar_one_or_none()
        inbox = 0
        if user_id is not None:
            inbox = len((await s.execute(select(Notification.id).where(Notification.user_id == user_id, Notification.type == "conversation.message"))).scalars().all())
        copies = [e for e in (await s.execute(select(Event).where(Event.recipient_id == member_id, Event.event_type == "dispatched"))).scalars().all()
                  if (e.payload or {}).get("event_type") == "conversation.message"]
    return sorted({j.kind for j in named}), inbox, len(copies)


async def _mute_toggle(Session, conv_id, member_id):
    from sqlalchemy import update
    from sqlalchemy.sql import func

    from app.models.conversation import ConversationParticipant

    async with Session() as s:
        await s.execute(update(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == member_id,
        ).values(muted_at=func.now()))
        await s.commit()


async def _preference(Session, conv_id, member_id, level):
    from app.models.notification_preference import NotificationPreference

    async with Session() as s:
        for channel in ("sse", "in_app", "discord", "telegram"):
            s.add(NotificationPreference(member_id=member_id, scope_type="conversation", scope_id=conv_id, channel=channel, level=level))
        await s.commit()


async def test_a_person_who_has_not_muted_is_still_pushed_and_noted_for_each_message():
    """control: what 1934 asked for is intact for everyone else"""
    engine, Session, org_id, _p, conv_id, (_sender, sender_user), reader, other = await _world()
    try:
        await _send(Session, org_id, sender_user, conv_id, "hello")
        kinds, inbox, copies = await _told(Session, org_id, reader)
        assert "expo_push" in kinds and inbox == 1 and copies == 1, (kinds, inbox, copies)
    finally:
        await engine.dispose()


async def test_a_person_who_muted_the_room_with_the_toggle_gets_no_push_no_inbox_row_no_copy():
    engine, Session, org_id, _p, conv_id, (_sender, sender_user), reader, other = await _world()
    try:
        await _mute_toggle(Session, conv_id, reader)
        await _send(Session, org_id, sender_user, conv_id, "hello")
        assert await _told(Session, org_id, reader) == ([], 0, 0)
        kinds, inbox, copies = await _told(Session, org_id, other)  # the other participant is untouched
        assert "expo_push" in kinds and inbox == 1 and copies == 1, (kinds, inbox, copies)
    finally:
        await engine.dispose()


async def test_a_person_whose_preference_for_the_room_is_mute_gets_nothing():
    engine, Session, org_id, _p, conv_id, (_sender, sender_user), reader, other = await _world(conv_type="group")
    try:
        await _preference(Session, conv_id, reader, "mute")
        await _send(Session, org_id, sender_user, conv_id, "hello")
        assert await _told(Session, org_id, reader) == ([], 0, 0)
    finally:
        await engine.dispose()


async def test_a_person_on_mentions_only_gets_nothing_for_a_message_that_does_not_mention_them():
    engine, Session, org_id, _p, conv_id, (_sender, sender_user), reader, other = await _world(conv_type="group")
    try:
        await _preference(Session, conv_id, reader, "mentions")
        await _send(Session, org_id, sender_user, conv_id, "hello")
        assert await _told(Session, org_id, reader) == ([], 0, 0)
        # …and the same person IS told when they are mentioned (that is the mention notification — not this one — and it is unchanged)
        await _send(Session, org_id, sender_user, conv_id, "hi there", mentioned=[reader])
        kinds, inbox, copies = await _told(Session, org_id, reader)
        assert (kinds, inbox, copies) == ([], 0, 0)  # still none from the 1934 notification (the mention one has its own event type)
    finally:
        await engine.dispose()
