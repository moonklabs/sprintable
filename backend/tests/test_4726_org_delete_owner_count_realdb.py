"""[SID:4726] real-DB — deleting an organization ends its org_members rows, so the one person who deleted their only organization can make a new one.

Before: `OrganizationRepository.delete_by_user` removed only the organizations row (org_members.org_id has no foreign key), the owner's row stayed with
deleted_at NULL, and `ee.plan_limits.check_org_create_limit` (free: one owned organization) kept counting it — 402 on the next organization.

Red when `delete_by_user` stops ending the rows (first three tests) or when the migration's backfill statement is emptied (the last).

DB env (ALEMBIC_DATABASE_URL or PARITY_TEST_DATABASE_URL: a Postgres with `alembic upgrade head` applied) is required, otherwise skip."""
from __future__ import annotations

import importlib.util
import os
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _org(session, owner_id, *, members=()):
    """An organization with an owner (and optional plain members). Returns (org_id, name)."""
    org_id = uuid.uuid4()
    name = f"t4726-{org_id}"
    await session.execute(
        text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :n, :s, 'free')"),
        {"id": org_id, "n": name, "s": f"s4726-{org_id}"},
    )
    await session.execute(
        text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"),
        {"id": uuid.uuid4(), "o": org_id, "u": owner_id},
    )
    for uid in members:
        await session.execute(
            text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'member')"),
            {"id": uuid.uuid4(), "o": org_id, "u": uid},
        )
    await session.commit()
    return org_id, name


async def _live_rows(session, org_id):
    return (await session.execute(
        text("SELECT user_id, role FROM org_members WHERE org_id = :o AND deleted_at IS NULL ORDER BY role"), {"o": org_id}
    )).all()


async def _ended_rows(session, org_id):
    """Rows that stay in the table with deleted_at set (soft-ended, not physically deleted)."""
    return (await session.execute(
        text("SELECT user_id, role FROM org_members WHERE org_id = :o AND deleted_at IS NOT NULL ORDER BY role"), {"o": org_id}
    )).all()


async def _cleanup(session, *org_ids):
    for o in org_ids:
        await session.execute(text("DELETE FROM org_members WHERE org_id = :o"), {"o": o})
        await session.execute(text("DELETE FROM deletion_audit_logs WHERE org_id = :o"), {"o": o})
        await session.execute(text("DELETE FROM organizations WHERE id = :o"), {"o": o})
    await session.commit()


@pytest.mark.anyio
async def test_a_only_organization_deleted_then_a_new_one_is_allowed():
    from app.repositories.organization import OrganizationRepository
    from ee import plan_limits

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    owner = uuid.uuid4()
    org_id = None
    try:
        async with Session() as session:
            org_id, name = await _org(session, owner)
            # control: while the organization lives, the free plan's one owned organization is taken
            with pytest.raises(HTTPException) as full:
                await plan_limits.check_org_create_limit(session, owner)
            assert full.value.status_code == 402

            result = await OrganizationRepository(session).delete_by_user(org_id=org_id, user_id=owner, confirmation=name)
            await session.commit()
            assert result == {"ok": True}

            assert await _live_rows(session, org_id) == []  # the owner's row ended with the organization
            assert [(r[0], r[1]) for r in await _ended_rows(session, org_id)] == [(owner, "owner")]  # soft-ended: the row is still there
            await plan_limits.check_org_create_limit(session, owner)  # no raise: the slot is back
    finally:
        async with Session() as session:
            await _cleanup(session, *( [org_id] if org_id else [] ))
        await engine.dispose()


@pytest.mark.anyio
async def test_b_other_organization_still_counts_and_other_members_end_with_their_organization():
    from app.repositories.organization import OrganizationRepository
    from ee import plan_limits

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    owner, other_owner, member = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    made = []
    try:
        async with Session() as session:
            a, a_name = await _org(session, owner, members=(member,))
            b, _ = await _org(session, other_owner, members=(member,))  # `member` also belongs to another, untouched organization
            made += [a, b]

            result = await OrganizationRepository(session).delete_by_user(org_id=a, user_id=owner, confirmation=a_name)
            await session.commit()
            assert result == {"ok": True}

            assert await _live_rows(session, a) == []  # owner and plain member of the deleted organization both ended
            assert {r[0] for r in await _ended_rows(session, a)} == {owner, member}  # ... and both rows are still there (not physically deleted)
            assert {r[0] for r in await _live_rows(session, b)} == {other_owner, member}  # the other organization is untouched
            with pytest.raises(HTTPException) as still_full:  # a person who still owns another organization stays at the limit
                await plan_limits.check_org_create_limit(session, other_owner)
            assert still_full.value.status_code == 402
    finally:
        async with Session() as session:
            await _cleanup(session, *made)
        await engine.dispose()


@pytest.mark.anyio
async def test_c_a_rejected_delete_ends_nothing():
    """A wrong confirmation name (or any refusal) leaves the organization AND its rows alone."""
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    owner = uuid.uuid4()
    org_id = None
    try:
        async with Session() as session:
            org_id, _ = await _org(session, owner)
            result = await OrganizationRepository(session).delete_by_user(org_id=org_id, user_id=owner, confirmation="not-the-name")
            await session.commit()
            assert result == {"ok": False, "reason": "confirmation_mismatch"}
            assert len(await _live_rows(session, org_id)) == 1
            assert (await session.execute(text("SELECT 1 FROM organizations WHERE id = :o"), {"o": org_id})).first() is not None
    finally:
        async with Session() as session:
            await _cleanup(session, *( [org_id] if org_id else [] ))
        await engine.dispose()


@pytest.mark.anyio
async def test_e_a_live_owner_row_of_a_missing_organization_does_not_count():
    """What the delete path cannot rule out: a membership write that lands while the organization is being deleted (no foreign key to
    serialize on) leaves a live owner row for an organization that no longer exists. The limit counts existing organizations only, so that
    person can still make a new one — while an owner row of an organization that exists still counts (control)."""
    from ee import plan_limits

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    straggler, real_owner = uuid.uuid4(), uuid.uuid4()
    gone_org, live_org = uuid.uuid4(), uuid.uuid4()
    try:
        async with Session() as session:  # one transaction, rolled back: nothing stays in the shared database
            await session.execute(
                text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"),
                {"id": uuid.uuid4(), "o": gone_org, "u": straggler},
            )
            await plan_limits.check_org_create_limit(session, straggler)  # no raise: the orphan does not count

            await session.execute(
                text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :n, :s, 'free')"),
                {"id": live_org, "n": f"t4726-{live_org}", "s": f"s4726-{live_org}"},
            )
            await session.execute(
                text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"),
                {"id": uuid.uuid4(), "o": live_org, "u": real_owner},
            )
            with pytest.raises(HTTPException) as full:  # control: an existing organization's owner row still takes the slot
                await plan_limits.check_org_create_limit(session, real_owner)
            assert full.value.status_code == 402
            await session.rollback()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_d_backfill_ends_rows_left_by_organizations_deleted_before_the_fix():
    """Runs the migration's own statement, but inside one transaction that is rolled back: the statement is global (it ends every orphaned
    row in the table), and this suite shares its database with other real-DB tests whose own rows must not be touched for good."""
    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0456_org_members_orphan_backfill.py"
    spec = importlib.util.spec_from_file_location("rev_0456", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    stranded_owner, live_owner = uuid.uuid4(), uuid.uuid4()
    gone_org, live_org = uuid.uuid4(), uuid.uuid4()  # gone_org: deleted before the fix — only its org_members row is left
    try:
        async with Session() as session:
            await session.execute(
                text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"),
                {"id": uuid.uuid4(), "o": gone_org, "u": stranded_owner},
            )
            await session.execute(
                text("INSERT INTO organizations (id, name, slug, plan) VALUES (:id, :n, :s, 'free')"),
                {"id": live_org, "n": f"t4726-{live_org}", "s": f"s4726-{live_org}"},
            )
            await session.execute(
                text("INSERT INTO org_members (id, org_id, user_id, role) VALUES (:id, :o, :u, 'owner')"),
                {"id": uuid.uuid4(), "o": live_org, "u": live_owner},
            )

            await session.execute(text(mod.BACKFILL_SQL))
            assert await _live_rows(session, gone_org) == []  # stranded row ended
            assert [(r[0], r[1]) for r in await _ended_rows(session, gone_org)] == [(stranded_owner, "owner")]  # ... and kept
            assert len(await _live_rows(session, live_org)) == 1  # a live organization's row is left alone

            await session.execute(text(mod.BACKFILL_SQL))  # running it again changes nothing
            assert len(await _live_rows(session, live_org)) == 1
            assert len(await _ended_rows(session, gone_org)) == 1

            await session.rollback()  # nothing of this test (nor the global effect of the statement) stays in the shared database
            assert await _ended_rows(session, gone_org) == []
    finally:
        await engine.dispose()
