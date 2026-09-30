"""story #4444 — anyone who can be in a conversation can block, and be blocked (a safety feature: #2349 · the store policy).

Blocking asked for a project team-member row, on both sides. A person in the org without a project row (an org owner or
admin, often) got 400 «team member required to use blocking» on every block call, and blocking such a person gave 404
«member not found». The key was never the problem: `user_blocks` holds members.id, and a person's team-member id and
org-membership id are the same value (0075) — only the «must be a team-member row» checks stood in the way.

PO 23:00Z — the same two-step identity as #4437: a team-member row in this org, or else a membership of this org that is
not deleted. Four places: the caller, the target, the list, the read-side masking. No migration; existing rows unchanged.
Someone who left the org (membership deleted) is still hidden from the list and cannot be newly blocked; their row stays
(#2349 PO ①).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _add_message,
    _client_for,
    _make_conversation,
    _make_human_member,
    _make_org,
    _make_org_owner,
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


async def _make_org_person(session, org_id, role="member"):
    """A person in the org with no project row (grant-only): org membership + member anchor, same id (0075)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"person-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    await session.commit()
    session.add(Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Person"))
    await session.commit()
    return om.id, user_id


async def _leave_org(session, member_id):
    """The person leaves the org: their membership is deleted (soft) and any project access goes."""
    from sqlalchemy import delete, update

    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess

    await session.execute(delete(ProjectAccess).where(ProjectAccess.member_id == member_id))
    await session.execute(update(OrgMember).where(OrgMember.id == member_id).values(deleted_at=datetime.now(timezone.utc)))
    await session.commit()


async def _as(app, Session, user_id, org_id, fn):
    await _setup_app_human(app, Session, user_id, org_id)
    try:
        async with _client_for(app) as client:
            return await fn(client)
    finally:
        app.dependency_overrides.clear()


async def test_an_org_owner_without_a_project_row_blocks_lists_and_unblocks():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            owner_id, owner_user = await _make_org_owner(session, org.id)
            member_id, _ = await _make_human_member(session, org.id, project.id)
        from app.main import app

        async def flow(c):
            made = await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(member_id)})
            listed = await c.get("/api/v2/user-blocks")
            undone = await c.delete(f"/api/v2/user-blocks/{member_id}")
            after = await c.get("/api/v2/user-blocks")
            return made, listed, undone, after

        made, listed, undone, after = await _as(app, Session, owner_user, org.id, flow)
        assert made.status_code == 201, made.text
        assert made.json()["blocker_member_id"] == str(owner_id)
        assert listed.status_code == 200, listed.text
        assert [r["blocked_member_id"] for r in listed.json()] == [str(member_id)]
        assert undone.status_code == 204, undone.text
        assert after.json() == []
    finally:
        await engine.dispose()


async def test_a_person_without_a_project_row_can_be_blocked():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            member_id, member_user = await _make_human_member(session, org.id, project.id)
            person_id, _ = await _make_org_person(session, org.id)
        from app.main import app

        async def flow(c):
            return await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(person_id)}), await c.get("/api/v2/user-blocks")

        made, listed = await _as(app, Session, member_user, org.id, flow)
        assert made.status_code == 201, made.text
        assert [r["blocked_member_id"] for r in listed.json()] == [str(person_id)]
    finally:
        await engine.dispose()


async def test_an_org_owners_block_masks_on_read():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            owner_id, owner_user = await _make_org_owner(session, org.id)
            sender_id, _ = await _make_human_member(session, org.id, project.id)
            conv_id = await _make_conversation(session, org.id, project.id, [owner_id, sender_id], sender_id)
            await _add_message(session, conv_id, sender_id, "hello", datetime.now(timezone.utc))
        from app.main import app

        async def flow(c):
            before = await c.get(f"/api/v2/conversations/{conv_id}/messages")
            await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(sender_id)})
            return before, await c.get(f"/api/v2/conversations/{conv_id}/messages")

        before, after = await _as(app, Session, owner_user, org.id, flow)
        assert before.status_code == 200, before.text
        assert [m.get("is_blocked_sender") for m in before.json()["data"]] == [False]
        assert [m.get("is_blocked_sender") for m in after.json()["data"]] == [True]
    finally:
        await engine.dispose()


async def test_someone_who_left_the_org_is_hidden_and_cannot_be_newly_blocked():
    """#2349 PO ① unchanged: their row stays, the list hides it. A new block on them is 404 (not in this org)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            owner_id, owner_user = await _make_org_owner(session, org.id)
            gone_id, _ = await _make_org_person(session, org.id)
            gone_member_id, _ = await _make_human_member(session, org.id, project.id)
        from app.main import app

        async def block_both(c):
            return [await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(x)}) for x in (gone_id, gone_member_id)]

        assert [r.status_code for r in await _as(app, Session, owner_user, org.id, block_both)] == [201, 201]
        async with Session() as session:
            await _leave_org(session, gone_id)
            await _leave_org(session, gone_member_id)
            late_id, _ = await _make_org_person(session, org.id)
            await _leave_org(session, late_id)

        async def after(c):
            return await c.get("/api/v2/user-blocks"), await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(late_id)})

        listed, late = await _as(app, Session, owner_user, org.id, after)
        assert listed.json() == []
        assert late.status_code == 404, late.text

        from sqlalchemy import func, select

        from app.models.user_block import UserBlock

        async with Session() as session:
            kept = (await session.execute(select(func.count()).select_from(UserBlock).where(UserBlock.blocker_member_id == owner_id))).scalar_one()
        assert kept == 2  # the rows stay
    finally:
        await engine.dispose()


async def test_a_person_who_lost_project_access_but_is_still_in_the_org_stays_listed():
    """They can still talk (as an org person), so a block on them still stands and still shows."""
    from sqlalchemy import delete

    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            project = await _make_project(session, org.id)
            a_id, a_user = await _make_human_member(session, org.id, project.id)
            b_id, _ = await _make_human_member(session, org.id, project.id)
        from app.main import app

        assert (await _as(app, Session, a_user, org.id,
                          lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(b_id)}))).status_code == 201
        async with Session() as session:
            await session.execute(delete(ProjectAccess).where(ProjectAccess.member_id == b_id))
            await session.commit()
        listed = await _as(app, Session, a_user, org.id, lambda c: c.get("/api/v2/user-blocks"))
        assert [r["blocked_member_id"] for r in listed.json()] == [str(b_id)]
    finally:
        await engine.dispose()


async def test_a_person_of_another_org_is_still_404():
    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            other = await _make_org(session)
            _owner_id, owner_user = await _make_org_owner(session, org.id)
            stranger_id, _ = await _make_org_person(session, other.id)
        from app.main import app

        r = await _as(app, Session, owner_user, org.id,
                      lambda c: c.post("/api/v2/user-blocks", json={"blocked_member_id": str(stranger_id)}))
        assert r.status_code == 404, r.text
    finally:
        await engine.dispose()


async def test_the_list_carries_each_blocked_persons_name_from_this_org_only():
    """PO 23:05Z — the settings list showed «알 수 없는 구성원» for a person without a project row (their name lookup went
    through the team-member route, 404). The list now carries the name: a team-member row's name, or else the person's
    display name — never an email, never made up (null). Only people of this org: a row pointing at someone of another
    org never shows, so no name of theirs can leak."""
    from app.models.user import User
    from app.models.user_block import UserBlock

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = await _make_org(session)
            other = await _make_org(session)
            project = await _make_project(session, org.id)
            owner_id, owner_user = await _make_org_owner(session, org.id)
            member_id, _ = await _make_human_member(session, org.id, project.id)
            named_id, named_user = await _make_org_person(session, org.id)
            (await session.get(User, named_user)).display_name = "김하나"
            nameless_id, _ = await _make_org_person(session, org.id)
            stranger_id, stranger_user = await _make_org_person(session, other.id)
            (await session.get(User, stranger_user)).display_name = "다른 조직 사람"
            await session.commit()
            # a row that points outside the org (as if written before the check, or by hand) — must not show
            session.add(UserBlock(id=uuid.uuid4(), blocker_member_id=owner_id, blocked_member_id=stranger_id))
            await session.commit()
            from app.models.team import TeamMember
            from sqlalchemy import select
            member_name = (await session.execute(select(TeamMember.name).where(TeamMember.id == member_id).limit(1))).scalar_one()
        from app.main import app

        async def flow(c):
            for x in (member_id, named_id, nameless_id):
                assert (await c.post("/api/v2/user-blocks", json={"blocked_member_id": str(x)})).status_code == 201
            return await c.get("/api/v2/user-blocks")

        listed = await _as(app, Session, owner_user, org.id, flow)
        names = {r["blocked_member_id"]: r.get("blocked_member_name", "MISSING") for r in listed.json()}
        assert names == {str(member_id): member_name, str(named_id): "김하나", str(nameless_id): None}, names
        assert "다른 조직 사람" not in listed.text
        assert "@test.com" not in listed.text  # never an email
    finally:
        await engine.dispose()
