"""story #4519 (Didi 4507 live 03:46Z · AC0 03:51Z · PO OK) — one chat mention, one bell item.

`send_message_core` wrote the mentioned person's `conversation:mention` Event (`_dispatch_mention_events`), then the
`conversation.mention` notification wrote a second, `dispatched` Event for the same person (no `human_event_recorded_for`, the
skip 4281 gave agent_dispatch): one mention showed twice on the bell — for a person with a project row since before 4919, and for
an org member without one since 4919. The copy also ignored a muted conversation (the bell's mute rule reads conversation events
only). Now the notification skips the Event for whoever got their mention Event; the inbox (Notification) is unchanged.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_agent_member,
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


async def _org_member_only(session, org_id, *, role="admin"):
    """An org member with no project row (no grant) — the desktop-setup owner's shape. (member id, user id)"""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"om-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return om.id, user.id


async def _world():
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        sender, sender_user = await _make_human_member(s, org.id, project.id)
        teammate, teammate_user = await _make_human_member(s, org.id, project.id)
        org_only, org_only_user = await _org_member_only(s, org.id)
    return engine, Session, org.id, project.id, (sender, sender_user), (teammate, teammate_user), (org_only, org_only_user)


async def _send(Session, org_id, sender_user, conv_id, mentioned):
    from app.main import app

    await _setup_app_human(app, Session, sender_user, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/conversations/{conv_id}/messages",
                                  json={"content": "hey", "mentioned_ids": [str(m) for m in mentioned]})
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 201, r.text
    body = r.json()
    return uuid.UUID((body.get("data") or body)["id"])


async def _bell_mentions(Session, org_id, user_id, msg_id, conv_id):
    """The person's bell (GET /event-notifications — mute applied there): the items that are this mention."""
    from app.main import app

    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            r = await client.get("/api/v2/event-notifications")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    items = r.json().get("data", r.json()) if isinstance(r.json(), dict) else r.json()
    return [i for i in items if (
        (i["event_type"] == "conversation:mention" and i.get("source_entity_id") == str(msg_id))
        or (i["event_type"] == "dispatched" and (i.get("payload") or {}).get("event_type") == "conversation.mention"
            and i.get("source_entity_id") == str(conv_id))
    )]


async def _inbox_mentions(Session, user_id):
    from sqlalchemy import func, select

    from app.models.notification import Notification

    async with Session() as s:
        return (await s.execute(select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id, Notification.type == "conversation.mention",
        ))).scalar_one()


async def test_a_mention_is_one_bell_item_for_a_teammate_and_for_an_org_member_without_a_project_row():
    engine, Session, org_id, project_id, (sender, sender_user), (mate, mate_user), (om, om_user) = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, mate], sender, conv_type="group")
        msg_id = await _send(Session, org_id, sender_user, conv_id, [mate, om])
        for user_id in (mate_user, om_user):
            bell = await _bell_mentions(Session, org_id, user_id, msg_id, conv_id)
            assert [i["event_type"] for i in bell] == ["conversation:mention"], bell  # before: + dispatched
            assert await _inbox_mentions(Session, user_id) == 1  # the inbox unchanged
    finally:
        await engine.dispose()


async def test_a_mention_in_a_muted_conversation_stays_off_the_bell():
    """The mute rule reads conversation events; the dispatched copy slipped past it."""
    from sqlalchemy import update

    from app.models.conversation import ConversationParticipant
    from sqlalchemy.sql import func

    engine, Session, org_id, project_id, (sender, sender_user), (mate, mate_user), _om = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, mate], sender, conv_type="group")
            await s.execute(update(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conv_id, ConversationParticipant.member_id == mate,
            ).values(muted_at=func.now()))
            await s.commit()
        msg_id = await _send(Session, org_id, sender_user, conv_id, [mate])
        assert await _bell_mentions(Session, org_id, mate_user, msg_id, conv_id) == []
    finally:
        await engine.dispose()


async def test_an_agents_mention_event_is_as_before():
    """The agent path is untouched: its conversation:mention Event (the SSE delivery) and no notification Event."""
    from sqlalchemy import select

    from app.models.event import Event

    engine, Session, org_id, project_id, (sender, sender_user), _mate, _om = await _world()
    try:
        async with Session() as s:
            agent = await _make_agent_member(s, org_id, project_id)
            agent_id = agent[0] if isinstance(agent, tuple) else agent
            conv_id = await _make_conversation(s, org_id, project_id, [sender, agent_id], sender, conv_type="group")
        msg_id = await _send(Session, org_id, sender_user, conv_id, [agent_id])
        async with Session() as s:
            kinds = (await s.execute(select(Event.event_type).where(Event.recipient_id == agent_id))).scalars().all()
        assert kinds.count("conversation:mention") == 1 and "dispatched" not in kinds, kinds
        _ = msg_id
    finally:
        await engine.dispose()


async def test_when_the_mention_event_is_not_written_the_notification_keeps_its_one_bell_item(monkeypatch):
    """The skip is only for who really got their mention Event: a mention Event write that fails (its savepoint rolled back)
    leaves the notification's own Event — still one bell item, never zero."""
    import app.routers.conversations as conversations

    async def broken(*_a, **_k):
        raise RuntimeError("mention event write failed")

    monkeypatch.setattr(conversations, "_dispatch_mention_events", broken)
    engine, Session, org_id, project_id, (sender, sender_user), (mate, mate_user), _om = await _world()
    try:
        async with Session() as s:
            conv_id = await _make_conversation(s, org_id, project_id, [sender, mate], sender, conv_type="group")
        msg_id = await _send(Session, org_id, sender_user, conv_id, [mate])
        bell = await _bell_mentions(Session, org_id, mate_user, msg_id, conv_id)
        assert [i["event_type"] for i in bell] == ["dispatched"], bell
    finally:
        await engine.dispose()
