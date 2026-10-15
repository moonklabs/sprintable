"""story #4507 (PO 14:27Z · dev 7 days: 474 of 1,937 notifications went to 26 org_members-only people) — the bell reads Event
rows only, and `dispatch_notification` wrote none for a person who is an org member without a project team row (33 of 34
desktop-setup owners): their notifications reached the inbox page and the phone, never the bell or its unread count.
Also the board's live updates: a person granted the project through an org-member grant row is a recipient.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4500_recipient_org_scope_realdb import _two_orgs

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


async def _person(Session, org_id, *, role="admin", team_project=None):
    """(member id the delivery uses, user id) — an org member only, or (team_project) a human team member of that project."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember
    from app.models.user import User

    async with Session() as s:
        user = User(id=uuid.uuid4(), email=f"p-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
        s.add(user)
        await s.flush()
        om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
        s.add(om)
        member_id = om.id
        if team_project is not None:
            member_id = uuid.uuid4()
            s.add(TeamMember(id=member_id, org_id=org_id, project_id=team_project, type="human", name="팀원 사람",
                             user_id=user.id, is_active=True))
        await s.commit()
        return member_id, user.id


async def _bell_and_inbox(Session, member_id, user_id, ref_id):
    from sqlalchemy import select

    from app.models.event import Event
    from app.models.notification import Notification

    async with Session() as s:
        events = (await s.execute(select(Event.project_id).where(
            Event.recipient_id == member_id, Event.event_type == "dispatched", Event.source_entity_id == ref_id,
        ))).scalars().all()
        notes = (await s.execute(select(Notification.id).where(
            Notification.user_id == user_id, Notification.reference_id == ref_id,
        ))).scalars().all()
    return list(events), len(notes)


async def _dispatch(Session, w, targets, *, source_project_id, ref_id=None):
    from app.services.notification_dispatch import dispatch_notification

    ref_id = ref_id or uuid.uuid4()
    async with Session() as s:
        await dispatch_notification(
            s, org_id=w.org_a, event_type="story_assigned", target_member_ids=targets, title="담당 배정",
            reference_type="story", reference_id=ref_id, source_project_id=source_project_id,
        )
        await s.commit()
    return ref_id


async def test_an_org_members_only_person_gets_the_bell_event_in_the_triggering_project():
    """An org owner with no team row → a Notification (inbox page) and now a bell Event in the triggering project; a human
    team member → both, in their own project, as before (control); org B's org member → nothing."""
    engine, Session, w = await _two_orgs()
    try:
        owner, owner_user = await _person(Session, w.org_a, role="owner")
        teammate, teammate_user = await _person(Session, w.org_a, team_project=w.project_a)
        stranger, stranger_user = await _person(Session, w.org_b, role="owner")
        ref = await _dispatch(Session, w, [owner, teammate, stranger], source_project_id=w.project_a)
        assert await _bell_and_inbox(Session, owner, owner_user, ref) == ([w.project_a], 1)
        assert await _bell_and_inbox(Session, teammate, teammate_user, ref) == ([w.project_a], 1)
        assert await _bell_and_inbox(Session, stranger, stranger_user, ref) == ([], 0)
    finally:
        await engine.dispose()


async def test_with_no_triggering_project_the_bell_event_takes_the_references_project():
    """Several gate kinds are created with no project (ads boost · channel / site posts · newsletter · recipe gates): their
    alert has no triggering project. The bell Event then goes under the project of what the notification is about — here a
    story of org A."""
    engine, Session, w = await _two_orgs()
    try:
        owner, owner_user = await _person(Session, w.org_a, role="owner")
        ref = await _dispatch(Session, w, [owner], source_project_id=None, ref_id=w.story)
        assert await _bell_and_inbox(Session, owner, owner_user, ref) == ([w.project_a], 1)
    finally:
        await engine.dispose()


async def test_with_no_project_at_all_the_person_gets_the_inbox_notification_only():
    """The rule's edge: no roster project, no triggering project and a reference that resolves to none → no Event can be made
    (project_id NOT NULL) — the Notification alone, as before."""
    engine, Session, w = await _two_orgs()
    try:
        owner, owner_user = await _person(Session, w.org_a, role="owner")
        ref = await _dispatch(Session, w, [owner], source_project_id=None)
        assert await _bell_and_inbox(Session, owner, owner_user, ref) == ([], 1)
    finally:
        await engine.dispose()


async def test_the_board_reaches_a_person_granted_through_an_org_member_grant_row():
    """project_accessible_member_ids: a plain member granted the project by an org-member grant row (no team row) is a
    recipient; the same role with no grant is not; owners and admins are, as before; another org's grant is not."""
    from sqlalchemy import text

    from app.services.project_auth import project_accessible_member_ids

    engine, Session, w = await _two_orgs()
    try:
        granted, _ = await _person(Session, w.org_a, role="member")
        not_granted, _ = await _person(Session, w.org_a, role="member")
        admin, _ = await _person(Session, w.org_a, role="admin")
        foreign, _ = await _person(Session, w.org_b, role="member")
        async with Session() as s:
            for om in (granted, foreign):
                await s.execute(text(
                    "INSERT INTO project_access (id, project_id, org_member_id, permission) VALUES (:i, :p, :o, 'granted')"
                ), {"i": uuid.uuid4(), "p": w.project_a, "o": om})
            await s.commit()
        async with Session() as s:
            got = {uuid.UUID(str(m)) for m in await project_accessible_member_ids(s, w.org_a, w.project_a)}
        assert granted in got and admin in got
        assert not_granted not in got and foreign not in got
    finally:
        await engine.dispose()


async def test_a_bell_event_goes_only_under_a_project_the_person_can_open():
    """Qadir 4919: a triggering project the person cannot access would leave a bell item they cannot open (the single read
    answers 403) — a plain member with no grant gets the inbox Notification only; with a grant, the bell Event too."""
    from sqlalchemy import text

    engine, Session, w = await _two_orgs()
    try:
        outsider, outsider_user = await _person(Session, w.org_a, role="member")
        granted, granted_user = await _person(Session, w.org_a, role="member")
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, permission) VALUES (:i, :p, :o, 'granted')"
            ), {"i": uuid.uuid4(), "p": w.project_a, "o": granted})
            await s.commit()
        ref = await _dispatch(Session, w, [outsider, granted], source_project_id=w.project_a)
        assert await _bell_and_inbox(Session, outsider, outsider_user, ref) == ([], 1)
        assert await _bell_and_inbox(Session, granted, granted_user, ref) == ([w.project_a], 1)
    finally:
        await engine.dispose()


async def test_the_board_leaves_out_a_denied_grant_and_a_deleted_member():
    """The grant branch's own conditions (Qadir 4919): a row that is not 'granted' (denied · revoked) and a member who left
    (deleted_at) are not recipients — each pinned on its own."""
    from sqlalchemy import text

    from app.services.project_auth import project_accessible_member_ids

    engine, Session, w = await _two_orgs()
    try:
        denied, _ = await _person(Session, w.org_a, role="member")
        left, _ = await _person(Session, w.org_a, role="member")
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, permission) VALUES (:i, :p, :o, 'denied')"
            ), {"i": uuid.uuid4(), "p": w.project_a, "o": denied})
            await s.execute(text(
                "INSERT INTO project_access (id, project_id, org_member_id, permission) VALUES (:i, :p, :o, 'granted')"
            ), {"i": uuid.uuid4(), "p": w.project_a, "o": left})
            await s.execute(text("UPDATE org_members SET deleted_at = now() WHERE id = :o"), {"o": left})
            await s.commit()
        async with Session() as s:
            got = {uuid.UUID(str(m)) for m in await project_accessible_member_ids(s, w.org_a, w.project_a)}
        assert denied not in got and left not in got
    finally:
        await engine.dispose()
