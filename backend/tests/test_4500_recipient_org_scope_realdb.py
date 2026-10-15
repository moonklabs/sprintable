"""story #4500 (Qadir 4912 QA 12:28Z · PO 12:32Z) — the places that draw recipients from assignees · participants, and the
ack · verify reads, handle only the org's own members and events.

4497 closed the write (an assignee outside the org → 422) and the inbox read. These places still took members and events by
id or recipient alone. dev holds no such rows today (PO 12:30Z), so each test plants another org's member or event directly and
checks that nothing reaches it — with the org's own member as the positive control.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_org, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,  # the seeds write team_members (a table in the destructive schema, a view when migrated)
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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


async def _two_orgs():
    """Org A with its own agent and a story; org B with its agent."""
    from app.models.pm import Story

    engine, Session = await _session_factory()
    async with Session() as s:
        org_a, project_a = await _seed_org(s)
        org_b, project_b = await _seed_org(s)
        own = await _seed_agent(s, org_a, project_a, grant=True)
        foreign = await _seed_agent(s, org_b, project_b, grant=True)
        story = Story(id=uuid.uuid4(), org_id=org_a, project_id=project_a, title="A의 스토리", status="todo")
        s.add(story)
        await s.commit()
    return engine, Session, SimpleNamespace(org_a=org_a, project_a=project_a, org_b=org_b, project_b=project_b,
                                            own=own, foreign=foreign, story=story.id)


async def _stakeholders(Session, org_id, payload):
    from app.services.event_routing_resolver import resolve_routing_leg

    async with Session() as s:
        return await resolve_routing_leg(
            {"kind": "server_derived", "target": "work_item_stakeholders"}, payload=payload, org_id=org_id, db=s,
        )


# ── AC1 — work_item_stakeholders ─────────────────────────────────────────────

async def test_stakeholders_leave_out_another_orgs_member_planted_as_assignee():
    """Org A's story with org B's agent planted as its single assignee and as a join row (both, as written before 4497's
    check) → B's agent is not a recipient; A's own agent on the same story is (positive control)."""
    from sqlalchemy import text

    engine, Session, w = await _two_orgs()
    try:
        async with Session() as s:
            await s.execute(text("UPDATE stories SET assignee_id = :m WHERE id = :s"), {"m": w.foreign, "s": w.story})
            for m in (w.foreign, w.own):
                await s.execute(text("INSERT INTO story_assignees (id, org_id, story_id, member_id) VALUES (:i, :o, :s, :m)"),
                                {"i": uuid.uuid4(), "o": w.org_a, "s": w.story, "m": m})
            await s.commit()
        got = await _stakeholders(Session, w.org_a, {"work_item_type": "story", "work_item_id": str(w.story)})
        assert got == {w.own}
    finally:
        await engine.dispose()


async def test_stakeholders_leave_out_another_orgs_member_named_in_the_payload():
    """The payload keys (gate requester · draft author) name org B's agent → not a recipient; A's own agent named the same
    way is."""
    engine, Session, w = await _two_orgs()
    try:
        got = await _stakeholders(Session, w.org_a, {
            "work_item_type": "story", "work_item_id": str(w.story),
            "gate_requester_member_id": str(w.foreign), "gate_draft_author_member_id": str(w.own),
        })
        assert got == {w.own}
    finally:
        await engine.dispose()


async def test_another_orgs_story_id_gives_no_stakeholders():
    """A payload naming org B's story while resolving for org A: the story row is not A's — its assignees are not read
    (they used to be merged in anyway). B's story carries a join row naming A's own agent (org_id B), which only the
    «no row → no assignees» and «join rows of this org» guards keep out (the final member filter would let A's agent in)."""
    from sqlalchemy import text

    from app.models.pm import Story

    engine, Session, w = await _two_orgs()
    try:
        async with Session() as s:
            b_story = Story(id=uuid.uuid4(), org_id=w.org_b, project_id=w.project_b, title="B의 스토리", status="todo")
            s.add(b_story)
            await s.flush()
            await s.execute(text("INSERT INTO story_assignees (id, org_id, story_id, member_id) VALUES (:i, :o, :s, :m)"),
                            {"i": uuid.uuid4(), "o": w.org_b, "s": b_story.id, "m": w.own})
            await s.commit()
            b_story_id = b_story.id
        assert await _stakeholders(Session, w.org_a, {"work_item_type": "story", "work_item_id": str(b_story_id)}) == set()
    finally:
        await engine.dispose()


async def test_goal_owner_from_another_org_is_left_out():
    from app.models.pm import Goal
    from app.services.event_routing_resolver import resolve_routing_leg

    engine, Session, w = await _two_orgs()
    try:
        async with Session() as s:
            mine = Goal(id=uuid.uuid4(), org_id=w.org_a, project_id=w.project_a, title="A 목표", assignee_id=w.own)
            theirs = Goal(id=uuid.uuid4(), org_id=w.org_a, project_id=w.project_a, title="B가 담당", assignee_id=w.foreign)
            s.add_all([mine, theirs])
            await s.commit()
        leg = {"kind": "server_derived", "target": "goal_owner"}
        async with Session() as s:
            assert await resolve_routing_leg(leg, payload={"goal_id": str(theirs.id)}, org_id=w.org_a, db=s) == set()
            assert await resolve_routing_leg(leg, payload={"goal_id": str(mine.id)}, org_id=w.org_a, db=s) == {w.own}
    finally:
        await engine.dispose()


# ── AC3 — ack · verify ───────────────────────────────────────────────────────

async def _plant_events(Session, w, *, event_type="story_assigned"):
    """Org B's agent as the recipient of org A's event (seq 1) and of its own org's (seq 2), both pending."""
    from sqlalchemy import text

    async with Session() as s:
        for seq, org, project in ((1, w.org_a, w.project_a), (2, w.org_b, w.project_b)):
            await s.execute(text(
                "INSERT INTO events (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq) "
                "VALUES (:i, :o, :p, :t, :r, 'agent', '{}', 'pending', :q)"
            ), {"i": uuid.uuid4(), "o": org, "p": project, "t": event_type, "r": w.foreign, "q": seq})
        await s.commit()


async def test_an_agents_ack_marks_only_its_own_orgs_events_delivered():
    from sqlalchemy import select

    from app.models.event import Event
    from app.routers.agent_gateway import AckRequest, ack_event

    engine, Session, w = await _two_orgs()
    try:
        await _plant_events(Session, w)
        auth = SimpleNamespace(claims={"app_metadata": {"api_key_id": "k", "org_id": str(w.org_b)}}, user_id=str(w.foreign))
        async with Session() as s:
            await ack_event(AckRequest(seq=2), db=s, auth=auth)
        async with Session() as s:
            status = dict((await s.execute(select(Event.recipient_seq, Event.status).where(Event.recipient_id == w.foreign))).all())
        assert status == {1: "pending", 2: "delivered"}  # org A's row untouched by B's agent's ack
    finally:
        await engine.dispose()


async def test_verify_counts_only_a_verify_event_of_the_agents_own_org():
    from app.services.agent_verify import VERIFY_EVENT_TYPE, get_verification_state, get_verified_map

    engine, Session, w = await _two_orgs()
    try:
        await _plant_events(Session, w, event_type=VERIFY_EVENT_TYPE)
        async with Session() as s:
            state = await get_verification_state(s, w.foreign, org_id=w.org_b)
            assert state["verify_seq"] == 2  # its own org's (seq 2) — org A's verify row (seq 1) is not this agent's
    finally:
        await engine.dispose()
    # only another org's verify row → none at all
    engine, Session, w = await _two_orgs()
    try:
        from sqlalchemy import text

        async with Session() as s:
            await s.execute(text(
                "INSERT INTO events (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq) "
                "VALUES (:i, :o, :p, :t, :r, 'agent', '{}', 'pending', 7)"
            ), {"i": uuid.uuid4(), "o": w.org_a, "p": w.project_a, "t": VERIFY_EVENT_TYPE, "r": w.foreign})
            await s.commit()
        async with Session() as s:
            assert (await get_verification_state(s, w.foreign, org_id=w.org_b))["verify_seq"] is None
            from app.models.agent_gateway import AgentEventCursor

            s.add(AgentEventCursor(agent_id=w.foreign, acked_seq=7))
            await s.commit()
            assert (await get_verified_map(s, [w.foreign], org_id=w.org_b))[w.foreign] is False
    finally:
        await engine.dispose()


# ── AC2 — conversation participants · card recipients ───────────────────────

async def _conversation(Session, w, *, org=None, project=None, participants=()):
    """A conversation of org A (or the given org) with these participants and one message from A's own agent."""
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant

    async with Session() as s:
        conv = Conversation(id=uuid.uuid4(), org_id=org or w.org_a, project_id=project or w.project_a, type="group")
        s.add(conv)
        await s.flush()
        for m in participants:
            s.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=m))
        msg = ConversationMessage(id=uuid.uuid4(), conversation_id=conv.id, sender_id=w.own, content="안녕", mentioned_ids=[])
        s.add(msg)
        await s.commit()
        return conv.id, msg.id


async def _humans(Session, w):
    """A person in each org (team-member rows of type human)."""
    from app.models.team import TeamMember

    own_h, foreign_h = uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        s.add(TeamMember(id=own_h, org_id=w.org_a, project_id=w.project_a, type="human", name="A 사람", is_active=True))
        s.add(TeamMember(id=foreign_h, org_id=w.org_b, project_id=w.project_b, type="human", name="B 사람", is_active=True))
        await s.commit()
    return own_h, foreign_h


async def test_a_conversation_message_reaches_only_this_orgs_participants():
    """Org B's agent planted as a participant of org A's conversation → no Event, no push to it; a second A agent → both."""
    from sqlalchemy import select

    from app.models.conversation import Conversation, ConversationMessage
    from app.models.event import Event
    from app.models.team import TeamMember
    from app.routers.conversations import _dispatch_conversation_event

    engine, Session, w = await _two_orgs()
    try:
        async with Session() as s:
            other_own = await _seed_agent(s, w.org_a, w.project_a, grant=True)
        conv_id, msg_id = await _conversation(Session, w, participants=(w.own, other_own, w.foreign))
        async with Session() as s:
            conv = await s.get(Conversation, conv_id)
            msg = await s.get(ConversationMessage, msg_id)
            sender = (await s.execute(select(TeamMember).where(TeamMember.id == w.own).limit(1))).scalar_one()
            pushes = await _dispatch_conversation_event(s, conv, msg, w.org_a, sender)
            await s.commit()
        assert {p for p, _ in pushes} == {str(other_own)}
        async with Session() as s:
            to = set((await s.execute(select(Event.recipient_id).where(Event.source_entity_id == msg_id))).scalars().all())
        assert to == {other_own}
    finally:
        await engine.dispose()


async def test_a_human_intervention_notice_reaches_only_this_orgs_people():
    from sqlalchemy import select

    from app.models.conversation import Conversation, ConversationMessage
    from app.models.team import TeamMember
    from app.routers.conversations import _dispatch_human_intervention_event

    engine, Session, w = await _two_orgs()
    try:
        own_h, foreign_h = await _humans(Session, w)
        conv_id, msg_id = await _conversation(Session, w, participants=(w.own, own_h, foreign_h))
        async with Session() as s:
            conv = await s.get(Conversation, conv_id)
            msg = await s.get(ConversationMessage, msg_id)
            sender = (await s.execute(select(TeamMember).where(TeamMember.id == w.own).limit(1))).scalar_one()
            pushes = await _dispatch_human_intervention_event(s, conv, msg, w.org_a, sender, {w.own}, 3)
            await s.commit()
        assert {p for p, _ in pushes} == {str(own_h)}
    finally:
        await engine.dispose()


async def test_conversation_working_and_route_message_keep_to_this_orgs_members(monkeypatch):
    import app.routers.events as events_mod
    from app.services.channel_router import route_message
    from app.services.member_resolver import conversation_member_ids_in_org
    from app.services.presence_events import emit_conversation_working

    engine, Session, w = await _two_orgs()
    try:
        own_h, foreign_h = await _humans(Session, w)
        conv_id, msg_id = await _conversation(Session, w, participants=(w.own, own_h, foreign_h, w.foreign))
        # working signal: the participants it is sent to
        sent: list = []

        async def capture(org_id, event_type, data, member_ids=None, **kw):
            sent.append(set(member_ids or ()))

        monkeypatch.setattr(events_mod, "push_to_org_members", capture)
        await emit_conversation_working(w.org_a, conv_id)
        assert sent and sent[0] == {str(w.own), str(own_h)}
        # the same conversation asked for as org B's → nothing (its id can arrive from Redis)
        async with Session() as s:
            assert await conversation_member_ids_in_org(s, conv_id, w.org_b) == set()
        # route_message: the recipients it decides for
        async with Session() as s:
            decisions = await route_message(msg_id, s)
        assert {d.member_id for d in decisions} == {own_h}
    finally:
        await engine.dispose()


async def test_an_approval_card_update_reaches_only_this_orgs_members_in_this_orgs_conversations():
    """A card message found by gate_id: mentions of org B's agent are dropped, and a conversation of org B carrying the same
    gate_id gives nothing — for the «resolved» and the «tossed» notices alike."""
    from app.models.conversation import ConversationMessage
    from app.services.approval_delivery import notify_gate_card_recipients_resolved, notify_gate_tossed

    engine, Session, w = await _two_orgs()
    try:
        gate_id = uuid.uuid4()
        conv_a, _ = await _conversation(Session, w)
        # a second org-A agent, mentioned only on org B's conversation's card: only «this org's conversations» keeps it out
        # (it is an org-A member, so the member filter alone would let it in)
        async with Session() as s:
            a_only_on_b = await _seed_agent(s, w.org_a, w.project_a, grant=True)
        from app.models.conversation import Conversation

        async with Session() as s:
            conv_b = Conversation(id=uuid.uuid4(), org_id=w.org_b, project_id=w.project_b, type="group")
            s.add(conv_b)
            await s.flush()
            for conv, mentioned in ((conv_a, [w.own, w.foreign]), (conv_b.id, [w.foreign, a_only_on_b])):
                s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=conv, sender_id=w.own, content="카드",
                                          mentioned_ids=mentioned, msg_metadata={"approval_target": {"gate_id": str(gate_id)}}))
            await s.commit()
        async with Session() as s:
            resolved = await notify_gate_card_recipients_resolved(
                s, org_id=w.org_a, gate_id=gate_id, status="approved", resolver_id=None, resolved_at=None,
            )
            await s.rollback()
        assert {p for p, _ in resolved} == {str(w.own)}
        async with Session() as s:
            tossed = await notify_gate_tossed(s, org_id=w.org_a, gate_id=gate_id, target_conversation_id=conv_a, tossed_by_id=w.own)
            await s.rollback()
        assert {p for p, _ in tossed} == {str(w.own)}
    finally:
        await engine.dispose()


async def test_an_ack_counts_an_org_members_only_recipients_event_of_the_keys_org():
    """PO 12:57Z — 109 of dev's last-7-day events are addressed to a person in org_members only (no team_members row). The
    ack and verify compare the caller's org with Event.org_id directly; a lookup of the recipient in team_members would have
    dropped them. Such a recipient's event in the key's org is marked delivered (positive control); another org's is not."""
    from sqlalchemy import select, text

    from app.models.event import Event
    from app.models.project import OrgMember
    from app.models.user import User
    from app.routers.agent_gateway import AckRequest, ack_event

    engine, Session, w = await _two_orgs()
    try:
        async with Session() as s:
            user = User(id=uuid.uuid4(), email=f"om-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
            s.add(user)
            await s.flush()
            om = OrgMember(id=uuid.uuid4(), org_id=w.org_a, user_id=user.id, role="member")
            s.add(om)
            await s.flush()
            for seq, org, project in ((1, w.org_a, w.project_a), (2, w.org_b, w.project_b)):
                await s.execute(text(
                    "INSERT INTO events (id, org_id, project_id, event_type, recipient_id, recipient_type, payload, status, recipient_seq) "
                    "VALUES (:i, :o, :p, 'story_assigned', :r, 'human', '{}', 'pending', :q)"
                ), {"i": uuid.uuid4(), "o": org, "p": project, "r": om.id, "q": seq})
            await s.commit()
            om_id = om.id
        auth = SimpleNamespace(claims={"app_metadata": {"api_key_id": "k", "org_id": str(w.org_a)}}, user_id=str(om_id))
        async with Session() as s:
            await ack_event(AckRequest(seq=2), db=s, auth=auth)
        async with Session() as s:
            status = dict((await s.execute(select(Event.recipient_seq, Event.status).where(Event.recipient_id == om_id))).all())
        assert status == {1: "delivered", 2: "pending"}
    finally:
        await engine.dispose()


async def test_an_assignee_stored_under_a_living_persons_old_alias_id_still_receives():
    """PO 13:16Z (dev: 4 stories' assignee_id is an old id aliased in member_identity_aliases to a living org member of the same
    org) — the recipient rule resolves aliases first, then keeps this org's members: the person is reached, under the canonical
    id. Filtering the raw ids would drop them (they used to receive). The same for a conversation participant stored under the
    old id."""
    from sqlalchemy import text

    from app.models.member import Member, MemberIdentityAlias
    from app.models.team import TeamMember
    from app.services.member_resolver import conversation_member_ids_in_org

    engine, Session, w = await _two_orgs()
    try:
        person, old = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            s.add(Member(id=person, org_id=w.org_a, type="human", name="살아 있는 사람"))
            s.add(TeamMember(id=person, org_id=w.org_a, project_id=w.project_a, type="human", name="살아 있는 사람", is_active=True))
            await s.flush()
            s.add(MemberIdentityAlias(alias_id=old, member_id=person, org_id=w.org_a, alias_source="human_team_member"))
            await s.execute(text("UPDATE stories SET assignee_id = :m WHERE id = :s"), {"m": old, "s": w.story})
            await s.commit()
        got = await _stakeholders(Session, w.org_a, {"work_item_type": "story", "work_item_id": str(w.story)})
        assert got == {person}
        conv_id, _ = await _conversation(Session, w, participants=(w.own, old))
        async with Session() as s:
            assert await conversation_member_ids_in_org(s, conv_id, w.org_a) == {w.own, person}
        # an approval card that mentioned the old id: the card's update reaches the person (canonical id)
        from app.models.conversation import ConversationMessage
        from app.services.approval_delivery import notify_gate_card_recipients_resolved

        gate_id = uuid.uuid4()
        async with Session() as s:
            s.add(ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, sender_id=w.own, content="카드",
                                      mentioned_ids=[old], msg_metadata={"approval_target": {"gate_id": str(gate_id)}}))
            await s.commit()
        async with Session() as s:
            pushes = await notify_gate_card_recipients_resolved(
                s, org_id=w.org_a, gate_id=gate_id, status="approved", resolver_id=None, resolved_at=None,
            )
            await s.rollback()
        assert {p for p, _ in pushes} == {str(person)}
        from app.services.approval_delivery import notify_gate_tossed

        async with Session() as s:
            tossed = await notify_gate_tossed(s, org_id=w.org_a, gate_id=gate_id, target_conversation_id=conv_id, tossed_by_id=w.own)
            await s.rollback()
        assert {p for p, _ in tossed} == {str(person)}
    finally:
        await engine.dispose()
