"""story 4729 — accepting an invite and revoking it at the same moment must not overwrite each other's state.

Before: `accept` read the invite without a lock and wrote `status='accepted'` unconditionally; `revoke` wrote `status='revoked'` without looking at the
current status. So (A) accept reads → revoke commits → accept writes: the admin saw «revoked» but a member with the invite's role was made and the invite
ended `accepted`; (B) accept commits → revoke writes: a member exists and the invite said «revoked».
Now: accept locks the invite row (FOR UPDATE) and only a `pending` invite is accepted; revoke only turns a `pending` invite into `revoked` (an already
accepted invite is left alone and the caller is told so).

Real Postgres, two sessions, the interleaving is forced. DB env (ALEMBIC_DATABASE_URL or PARITY_TEST_DATABASE_URL) is required, otherwise skip."""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


class Seed:
    def __init__(self):
        self.org = uuid.uuid4()
        self.user = uuid.uuid4()
        self.invite = uuid.uuid4()
        self.token = f"t4729-{uuid.uuid4().hex}"
        self.email = f"invitee-{uuid.uuid4().hex[:8]}@d4729.test"


async def _sql(stmt: str, **params):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            res = await s.execute(text(stmt), params)
            rows = [tuple(r) for r in res.all()] if res.returns_rows else []
            await s.commit()
            return rows
    finally:
        await eng.dispose()


async def _seed() -> Seed:
    d = Seed()
    await _sql("INSERT INTO organizations (id, name, slug, plan) VALUES (:o, :n, :s, 'free')", o=d.org, n=f"o4729-{d.org}", s=f"s4729-{d.org}")
    await _sql(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        "VALUES (:u,:e,'x','Invitee',true,true,0,false,0)", u=d.user, e=d.email,
    )
    await _sql(
        "INSERT INTO org_invites (id, organization_id, email, role, token, status, expires_at) VALUES (:i, :o, :e, 'member', :t, 'pending', now() + interval '7 days')",
        i=d.invite, o=d.org, e=d.email, t=d.token,
    )
    return d


async def _cleanup(d: Seed) -> None:
    for stmt in (
        "DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id = :o)",
        "DELETE FROM members WHERE org_id = :o",
        "DELETE FROM org_members WHERE org_id = :o",
        "DELETE FROM org_invites WHERE organization_id = :o",
        "DELETE FROM organizations WHERE id = :o",
    ):
        await _sql(stmt, o=d.org)
    await _sql("DELETE FROM users WHERE id = :u", u=d.user)


async def _state(d: Seed) -> dict:
    status = (await _sql("SELECT status FROM org_invites WHERE id = :i", i=d.invite))[0][0]
    member = (await _sql("SELECT count(*) FROM org_members WHERE org_id = :o AND user_id = :u", o=d.org, u=d.user))[0][0]
    return {"invite": status, "member": member}


async def _accept(Session, d: Seed) -> dict:
    from app.repositories.org_invite import OrgInviteRepository

    async with Session() as s:
        result = await OrgInviteRepository(s).accept(d.token, d.user, d.email)
        await s.commit()
        return result


async def _revoke(Session, d: Seed):
    from app.repositories.org_invite import OrgInviteRepository

    async with Session() as s:
        invite = await OrgInviteRepository(s).revoke(invite_id=d.invite, org_id=d.org)
        await s.commit()
        return invite.status if invite is not None else None


def _consistent(final: dict, accept_result: dict, revoke_said: str | None) -> list[str]:
    """what must hold whatever the order: the invite's final status and the member agree, and neither answer lies about the outcome"""
    bad = []
    if (final["invite"] == "accepted") != (final["member"] == 1):
        bad.append(f"invite {final['invite']} but member count {final['member']}")
    if revoke_said == "revoked" and final["invite"] != "revoked":
        bad.append(f"the cancel answered «revoked» but the invite ended {final['invite']}")
    if revoke_said == "revoked" and final["member"]:
        bad.append("the cancel answered «revoked» but a member was made from the invite")
    if accept_result.get("ok") and final["invite"] == "revoked":
        bad.append("the accept said ok but the invite ended revoked")
    return bad


@pytest.mark.anyio
async def test_a_accept_reads_then_revoke_commits_then_accept_writes():
    """the forced interleaving: accept has read the invite and is about to write; the cancel runs in between. Either the cancel waits for the accept
    (the accept wins: member + accepted, the cancel is told so) or the cancel wins (no member) — never «cancel succeeded» AND a new member."""
    from app.repositories.org_invite import OrgInviteRepository

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d = await _seed()
    read_done, go = asyncio.Event(), asyncio.Event()
    original = OrgInviteRepository._ensure_member_anchor

    async def gated(self, org_id, user_id):
        read_done.set()  # accept has read the invite, nothing written for the invite status yet
        await go.wait()
        return await original(self, org_id, user_id)

    OrgInviteRepository._ensure_member_anchor = gated
    try:
        t1 = asyncio.create_task(_accept(Session, d))
        await asyncio.wait_for(read_done.wait(), 20)
        t2 = asyncio.create_task(_revoke(Session, d))
        await asyncio.wait({t2}, timeout=1.5)  # without a lock the cancel finishes here; with the row locked it waits for the accept
        go.set()
        accept_result = await asyncio.wait_for(t1, 20)
        revoke_said = await asyncio.wait_for(t2, 20)
        final = await _state(d)
        assert _consistent(final, accept_result, revoke_said) == [], f"accept={accept_result} revoke_said={revoke_said} final={final}"
    finally:
        OrgInviteRepository._ensure_member_anchor = original
        go.set()
        await _cleanup(d)
        await eng.dispose()


@pytest.mark.anyio
async def test_b_accept_commits_then_revoke_does_not_turn_an_accepted_invite_into_revoked():
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d = await _seed()
    try:
        accept_result = await _accept(Session, d)
        assert accept_result["ok"] is True
        revoke_said = await _revoke(Session, d)
        final = await _state(d)
        assert final == {"invite": "accepted", "member": 1}, final  # the cancel did not overwrite the accepted invite
        assert revoke_said == "accepted"  # and it tells the caller the invite is already accepted
        assert _consistent(final, accept_result, revoke_said) == []
    finally:
        await _cleanup(d)
        await eng.dispose()


@pytest.mark.anyio
async def test_c_revoke_first_then_accept_makes_no_member():
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d = await _seed()
    try:
        assert await _revoke(Session, d) == "revoked"
        accept_result = await _accept(Session, d)
        assert accept_result == {"ok": False, "reason": "invalid_status"}
        assert await _state(d) == {"invite": "revoked", "member": 0}
    finally:
        await _cleanup(d)
        await eng.dispose()


@pytest.mark.anyio
async def test_d_a_pending_invite_is_still_accepted_and_revoked_as_before():
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d1, d2 = await _seed(), await _seed()
    try:
        assert (await _accept(Session, d1))["ok"] is True
        assert await _state(d1) == {"invite": "accepted", "member": 1}
        assert await _revoke(Session, d2) == "revoked"
        assert await _revoke(Session, d2) == "revoked"  # revoking twice stays revoked
        assert await _state(d2) == {"invite": "revoked", "member": 0}
    finally:
        await _cleanup(d1)
        await _cleanup(d2)
        await eng.dispose()


@pytest.mark.anyio
async def test_e_a_stale_pending_copy_in_the_same_session_does_not_win_over_a_committed_cancel():
    """the sign-in fallback loads the invite as «pending» and then calls accept in the SAME session; a cancel that commits in between must still be
    seen (the locked read refreshes the loaded copy) — otherwise the accept makes a member and writes accepted over revoked."""
    from sqlalchemy import select

    from app.models.org_invite import OrgInvite
    from app.repositories.org_invite import OrgInviteRepository

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d = await _seed()
    try:
        async with Session() as s:
            loaded = (await s.execute(select(OrgInvite).where(OrgInvite.id == d.invite, OrgInvite.status == "pending"))).scalar_one()
            assert loaded.status == "pending"
            assert await _revoke(Session, d) == "revoked"  # another session cancels and commits
            result = await OrgInviteRepository(s).accept(d.token, d.user, d.email)
            await s.commit()
        assert result == {"ok": False, "reason": "invalid_status"}, result
        assert await _state(d) == {"invite": "revoked", "member": 0}
    finally:
        await _cleanup(d)
        await eng.dispose()


@pytest.mark.anyio
async def test_f_resend_waits_for_a_cancel_in_flight_and_then_finds_nothing_to_resend():
    from app.repositories.org_invite import OrgInviteRepository

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d = await _seed()
    try:
        async with Session() as canceller:
            assert (await OrgInviteRepository(canceller).revoke(invite_id=d.invite, org_id=d.org)).status == "revoked"  # not committed yet

            async def resend():
                async with Session() as s:
                    out = await OrgInviteRepository(s).resend(d.invite, d.org)
                    await s.commit()
                    return out

            t = asyncio.create_task(resend())
            await asyncio.wait({t}, timeout=1.5)  # without the lock the resend reads «pending» and updates the row once the cancel lets go
            await canceller.commit()
            assert await asyncio.wait_for(t, 20) is None  # the invite is revoked: nothing to resend (the route answers 404)
        assert await _state(d) == {"invite": "revoked", "member": 0}
    finally:
        await _cleanup(d)
        await eng.dispose()


@pytest.mark.anyio
async def test_g_the_cancel_route_answers_409_for_an_accepted_invite_and_the_invite_stays_accepted():
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.repositories.org_invite import OrgInviteRepository
    from app.routers.org_invites import revoke_org_invite

    class _OwnerOrgRepo:
        async def get_member_role(self, org_id, user_id):
            return "owner"

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d1, d2 = await _seed(), await _seed()
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    try:
        assert (await _accept(Session, d1))["ok"] is True
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await revoke_org_invite(id=d1.org, invite_id=d1.invite, auth=auth, invite_repo=OrgInviteRepository(s), org_repo=_OwnerOrgRepo(), session=s)
        assert exc.value.status_code == 409
        assert await _state(d1) == {"invite": "accepted", "member": 1}
        async with Session() as s:  # a pending invite is cancelled as before
            out = await revoke_org_invite(id=d2.org, invite_id=d2.invite, auth=auth, invite_repo=OrgInviteRepository(s), org_repo=_OwnerOrgRepo(), session=s)
        assert out.status == "revoked"
        assert await _state(d2) == {"invite": "revoked", "member": 0}
    finally:
        await _cleanup(d1)
        await _cleanup(d2)
        await eng.dispose()


@pytest.mark.anyio
async def test_h_a_cancel_with_another_organizations_id_leaves_the_invite_pending():
    """the conditional UPDATE itself carries the organization: an invite of organization A must not be turned into «revoked» by a cancel addressed to
    organization B (the answer is None either way — what matters is that the row is not written)."""
    from app.repositories.org_invite import OrgInviteRepository

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    d1, d2 = await _seed(), await _seed()
    try:
        async with Session() as s:
            assert await OrgInviteRepository(s).revoke(invite_id=d1.invite, org_id=d2.org) is None
            await s.commit()  # a caller that commits after the None must not have written anything
        assert await _state(d1) == {"invite": "pending", "member": 0}
    finally:
        await _cleanup(d1)
        await _cleanup(d2)
        await eng.dispose()
