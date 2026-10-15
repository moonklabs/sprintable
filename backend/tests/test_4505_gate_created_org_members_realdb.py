"""story #4505 (Qadir 4915 · PO 13:56Z) — the same recipient rule as 4500 in three more places.

- the new-gate signal (`conversation.gate_created`) reaches an approver who is an org member without a project team row (an
  org owner or admin): it used to keep this project's team_members rows only, so a new gate never appeared in such a person's
  open approvals inbox (dev, 30 days: 22 gates, 17 pending);
- a message's mentions resolve an old alias id to the living member before the org check;
- the human-intervention notice judges «is a person» on the canonical id, after the alias is resolved.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4500_recipient_org_scope_realdb import _conversation, _two_orgs

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


async def _org_member(Session, org_id):
    """A person who is an org member only — no team-member row (an org owner or admin without a project roster row)."""
    from app.models.project import OrgMember
    from app.models.user import User

    async with Session() as s:
        user = User(id=uuid.uuid4(), email=f"om-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
        s.add(user)
        await s.flush()
        om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="admin")
        s.add(om)
        await s.commit()
        return om.id


async def _alias_of_a_living_person(Session, org_id, project_id):
    """(old id, the person) — the person has a member row and a team row of type human; the old id is aliased to them."""
    from app.models.member import Member, MemberIdentityAlias
    from app.models.team import TeamMember

    person, old = uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        s.add(Member(id=person, org_id=org_id, type="human", name="살아 있는 사람"))
        s.add(TeamMember(id=person, org_id=org_id, project_id=project_id, type="human", name="살아 있는 사람", is_active=True))
        await s.flush()
        s.add(MemberIdentityAlias(alias_id=old, member_id=person, org_id=org_id, alias_source="human_team_member"))
        await s.commit()
    return old, person


async def test_the_new_gate_signal_reaches_an_org_member_approver_without_a_project_row():
    """Recipients: org A's own agent (a project team row), an org member of A with no team row, an old alias id of a living
    A person, and org B's agent → the first three are reached (the alias under the canonical id), B's is not."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.approval_delivery import notify_gate_created_to_recipients

    engine, Session, w = await _two_orgs()
    try:
        om = await _org_member(Session, w.org_a)
        old, person = await _alias_of_a_living_person(Session, w.org_a, w.project_a)
        gate_id = uuid.uuid4()
        async with Session() as s:
            await notify_gate_created_to_recipients(
                s, org_id=w.org_a, project_id=w.project_a, gate_id=gate_id, recipient_ids=[w.own, om, old, w.foreign],
            )
            await s.commit()
        async with Session() as s:
            rows = (await s.execute(select(Event.recipient_id, Event.project_id).where(
                Event.source_entity_id == gate_id, Event.event_type == "conversation.gate_created",
            ))).all()
        assert {r.recipient_id for r in rows} == {w.own, om, person}
        assert {r.project_id for r in rows} == {w.project_a}  # the project stays the Event's
    finally:
        await engine.dispose()


async def test_mentions_resolve_an_old_alias_id_then_keep_this_orgs_members_in_order():
    from app.services.member_resolver import org_mention_ids

    engine, Session, w = await _two_orgs()
    try:
        om = await _org_member(Session, w.org_a)
        old, person = await _alias_of_a_living_person(Session, w.org_a, w.project_a)
        async with Session() as s:
            got = await org_mention_ids([old, w.foreign, om, person, w.own], w.org_a, s)
        assert got == [person, om, w.own]  # the alias as the person · B's agent dropped · order kept · no repeat
    finally:
        await engine.dispose()


async def test_the_human_notice_counts_a_participant_stored_under_an_old_human_alias_id():
    """Participants: org A's agent, an old alias id of a living A person, an org member of A → people only: the person
    (canonical) and the org member; the agent is not a person. Judging «a person» on the raw old id would miss the alias."""
    from app.services.member_resolver import conversation_member_ids_in_org

    engine, Session, w = await _two_orgs()
    try:
        om = await _org_member(Session, w.org_a)
        old, person = await _alias_of_a_living_person(Session, w.org_a, w.project_a)
        conv_id, _ = await _conversation(Session, w, participants=(w.own, old, om))
        async with Session() as s:
            assert await conversation_member_ids_in_org(s, conv_id, w.org_a, humans_only=True) == {person, om}
            assert await conversation_member_ids_in_org(s, conv_id, w.org_a) == {w.own, person, om}
    finally:
        await engine.dispose()
