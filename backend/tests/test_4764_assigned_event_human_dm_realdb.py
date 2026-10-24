"""story #4764 — a human's assignment of an agent is delivered into the human <-> agent DM, once.

Measured 2026-10-24 (Mac 4757 D2, phone 4758 E6): the agent's first answer after «assign this story to the agent» landed in a
separate system-publisher <-> agent DM (only the «agent chats» tab, list line «work status changed»), while the DM the app opened
(me <-> the agent) stayed empty. Cause: `preset.work.assigned` routes to {assignee} + the work item's stakeholders; the person who
assigned (`assigned_by_member_id`) is neither, so the delivery conversation was {system publisher, agent} = a 2-member DM.

What this file pins (real PG, the real `publish_preset_event`):
- human assigns agent  -> the event message is in the conversation whose participants are exactly {human, agent}; the system
  publisher posted without joining it; exactly ONE copy of the event exists (no second delivery for the agent to answer twice);
- the same DM is reused when it already exists (the app's «me <-> agent» DM), not a new one;
- a human owner that is the assigner changes nothing; a DIFFERENT human owner keeps today's group {system, agent, owner};
- no assigner / an agent assigner / a human assignee / another event key keep today's path {system, assignee, stakeholders};
- `send_message_core(as_system_publisher=True)` is refused for anyone but the server's own system publisher.
Reverting the `_assigner_agent_dm_pair` use in `_publish_registry_event_core` turns the first two RED."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4764", slug=f"org4764-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, name):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"{name}-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name=name)
    session.add(m)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=m.id, permission="granted", role="member",
    ))
    await session.commit()
    return m.id


async def _seed_agent(session, org_id, project_id, *, name):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    a = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name, runtime_type="claude_code", is_active=True)
    session.add(a)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=a.id, permission="granted", role="member",
    ))
    await session.commit()
    return a.id


async def _seed_story(session, org_id, project_id, *, assignee_id, human_owner_member_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S4764", status="backlog",
        assignee_id=assignee_id, human_owner_member_id=human_owner_member_id,
    )
    session.add(story)
    await session.commit()
    return story.id


async def _seed_dm(session, org_id, project_id, a, b):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="dm", title=None, created_by=a)
    session.add(conv)
    await session.flush()
    for mid in (a, b):
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


def _assigned_payload(story_id, assignee_id, assigned_by_id):
    return {
        "work_item_type": "story",
        "work_item_id": str(story_id),
        "assignee_member_id": str(assignee_id),
        "assigned_by_member_id": str(assigned_by_id) if assigned_by_id else None,
    }


async def _publish(Session, org_id, key, payload):
    from app.routers.events import publish_preset_event

    async with Session() as s:
        result = await publish_preset_event(s, org_id, key, payload)
        await s.commit()
    return result


async def _delivery(Session, org_id, work_item_id, event_key="preset.work.assigned"):
    """-> (conversation ids holding this work item's event message, participants of each, the conversation types, sender ids)."""
    from sqlalchemy import select

    from app.models.conversation import (
        Conversation,
        ConversationMessage,
        ConversationParticipant,
    )

    async with Session() as s:
        rows = (await s.execute(
            select(ConversationMessage.conversation_id, ConversationMessage.sender_id, ConversationMessage.msg_metadata)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .where(Conversation.org_id == org_id)
        )).all()
        hits = [
            (cid, sender) for cid, sender, meta in rows
            if ((meta or {}).get("event") or {}).get("event_key") == event_key
            and (((meta or {}).get("event") or {}).get("payload") or {}).get("work_item_id") == str(work_item_id)
        ]
        out = []
        for cid, sender in hits:
            parts = set((await s.execute(
                select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == cid)
            )).scalars().all())
            ctype = (await s.execute(select(Conversation.type).where(Conversation.id == cid))).scalar_one()
            out.append({"conversation_id": cid, "sender_id": sender, "participants": parts, "type": ctype})
        return out


async def _created_by(Session, conversation_id):
    from sqlalchemy import select

    from app.models.conversation import Conversation

    async with Session() as s:
        return (await s.execute(select(Conversation.created_by).where(Conversation.id == conversation_id))).scalar_one()


async def _system_publisher_id(Session, org_id):
    from sqlalchemy import select

    from app.models.member import Member

    async with Session() as s:
        return (await s.execute(
            select(Member.id).where(Member.org_id == org_id, Member.runtime_type == "system-publisher")
        )).scalar_one()


async def test_human_assigns_agent_event_lands_in_their_dm_once():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent)

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, human))

        got = await _delivery(Session, org_id, story_id)
        system_id = await _system_publisher_id(Session, org_id)
        assert len(got) == 1, f"exactly one copy of the event (a second delivery would make the agent answer twice): {got}"
        assert got[0]["participants"] == {human, agent}, got
        assert got[0]["type"] == "dm"
        assert got[0]["sender_id"] == system_id
        assert system_id not in got[0]["participants"], "the system publisher posts without joining the DM"
        assert await _created_by(Session, got[0]["conversation_id"]) == human, (
            "a DM made for the event belongs to the assigner: `created_by` is a recipient of the chat websocket fan-out, "
            "and the system publisher is not in this DM"
        )
    finally:
        await engine.dispose()


async def test_existing_dm_of_the_pair_is_reused_not_duplicated():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent)
            app_dm = await _seed_dm(s, org_id, project_id, human, agent)  # the «me <-> agent» DM the app opened

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, human))
        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, human))  # re-assign

        got = await _delivery(Session, org_id, story_id)
        assert [g["conversation_id"] for g in got] == [app_dm, app_dm], got
        assert all(g["participants"] == {human, agent} for g in got)
    finally:
        await engine.dispose()


async def test_human_owner_who_is_the_assigner_changes_nothing():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent, human_owner_member_id=human)

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, human))

        got = await _delivery(Session, org_id, story_id)
        assert len(got) == 1 and got[0]["participants"] == {human, agent}, got
    finally:
        await engine.dispose()


async def test_a_different_human_owner_keeps_todays_group():
    """Decision (PO 4764 ④): the assigner's DM is preferred only when nobody else needs the event; a different human owner is a
    recipient the DM cannot reach, so that assignment keeps the group it always had — {system publisher, agent, owner}."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            owner = await _seed_human(s, org_id, project_id, name="owner")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent, human_owner_member_id=owner)

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, human))

        got = await _delivery(Session, org_id, story_id)
        system_id = await _system_publisher_id(Session, org_id)
        assert len(got) == 1, got
        assert got[0]["participants"] == {system_id, agent, owner}, got
        assert human not in got[0]["participants"]
    finally:
        await engine.dispose()


@pytest.mark.parametrize("assigner_kind", ["none", "agent"])
async def test_no_human_assigner_keeps_the_system_agent_dm(assigner_kind):
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            other_agent = await _seed_agent(s, org_id, project_id, name="other-agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent)
        assigner = None if assigner_kind == "none" else other_agent

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, agent, assigner))

        got = await _delivery(Session, org_id, story_id)
        system_id = await _system_publisher_id(Session, org_id)
        assert len(got) == 1 and got[0]["participants"] == {system_id, agent}, got
    finally:
        await engine.dispose()


async def test_human_assignee_keeps_todays_path():
    """human -> human assignment: the assignee is not an agent, so nothing moves into a DM of the two humans."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            assigner = await _seed_human(s, org_id, project_id, name="assigner")
            assignee = await _seed_human(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee)

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, assignee, assigner))

        got = await _delivery(Session, org_id, story_id)
        system_id = await _system_publisher_id(Session, org_id)
        assert len(got) == 1 and got[0]["participants"] == {system_id, assignee}, got
    finally:
        await engine.dispose()


async def test_other_event_keys_do_not_take_the_assigners_dm():
    """`preset.work.status_changed` of the same story keeps its own delivery ({system, agent}); only the assignment moves."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=agent)

        await _publish(Session, org_id, "preset.work.status_changed", {
            "work_item_type": "story", "work_item_id": str(story_id),
            "from_status": "backlog", "to_status": "in-progress", "changed_by_member_id": str(human),
        })

        got = await _delivery(Session, org_id, story_id, event_key="preset.work.status_changed")
        system_id = await _system_publisher_id(Session, org_id)
        assert len(got) == 1 and got[0]["participants"] == {system_id, agent}, got
    finally:
        await engine.dispose()


async def test_only_the_servers_system_publisher_may_post_without_joining():
    from fastapi import BackgroundTasks, HTTPException

    from app.dependencies.auth import AuthContext
    from app.routers.conversations import SendMessageRequest, send_message_core

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            agent = await _seed_agent(s, org_id, project_id, name="agent")
            outsider = await _seed_agent(s, org_id, project_id, name="outsider")
            dm = await _seed_dm(s, org_id, project_id, human, agent)

        async def _post(sender_id, *, with_after_commit):
            async with Session() as s:
                auth = AuthContext(
                    user_id=str(sender_id), email=None,
                    claims={"app_metadata": {"api_key_id": "k", "org_id": str(org_id)}}, org_id=str(org_id),
                )
                await send_message_core(
                    dm, SendMessageRequest(content="hi"), BackgroundTasks(), db=s, auth=auth, org_id=org_id,
                    after_commit=[] if with_after_commit else None, as_system_publisher=True,
                )

        # an ordinary agent asking for the exemption is refused (with or without the server hook list)
        for flag in (True, False):
            with pytest.raises(HTTPException) as exc:
                await _post(outsider, with_after_commit=flag)
            assert exc.value.status_code == 403
    finally:
        await engine.dispose()


async def test_the_system_publisher_as_assignee_is_not_given_a_persons_dm():
    """The system publisher is an `agent` member too; a (mis)assignment to it must not make it a participant of a human's DM."""
    from app.routers.events import _get_or_create_system_publisher

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human = await _seed_human(s, org_id, project_id, name="human")
            system_id = (await _get_or_create_system_publisher(s, org_id)).id
            await s.commit()
            story_id = await _seed_story(s, org_id, project_id, assignee_id=system_id)

        await _publish(Session, org_id, "preset.work.assigned", _assigned_payload(story_id, system_id, human))

        got = await _delivery(Session, org_id, story_id)
        assert len(got) == 1 and human not in got[0]["participants"], got
    finally:
        await engine.dispose()
