"""story 5021 — an invitation never hands out an organization role its maker may not give.

Before: `CreateOrgInvite.role` was a bare string and nothing on the server looked at it — an ADMIN (who may make invitations) could make a `role=owner` invitation, the person who accepted it became an OWNER
(role escalation; the same code runs hosted and embedded), and any other string (`superuser`) was stored and copied into `org_members.role` on accept.
Now: the schema takes only owner / admin / member (422 otherwise); the maker's role decides (owner → all three · admin → admin and member — the rule PO fixed for changing a member's role, story 3491 ·
services/org_role_policy.py); and ACCEPT asks once more whether the maker may STILL give that role (an invitation made before the rule, or by someone since demoted · removed · deleted, is refused).

Real Postgres (ALEMBIC_DATABASE_URL or PARITY_TEST_DATABASE_URL), the API through the app with the caller faked, the accept through the one repository method every accept path uses. No DB URL → skipped."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

needs_db = pytest.mark.skipif(not _RAW, reason="real-DB URL not set — skip")  # the pure rule test below runs without a database


@pytest.fixture
def anyio_backend():
    return "asyncio"


class World:
    def __init__(self):
        self.org = uuid.uuid4()
        self.owner = uuid.uuid4()
        self.admin = uuid.uuid4()
        self.plain = uuid.uuid4()  # a plain member
        self.invitee = uuid.uuid4()
        self.removed = uuid.uuid4()  # a maker who is no longer in the organization (made in the tests that need him)
        self.soft_deleted = uuid.uuid4()  # a maker whose membership row is soft-deleted
        self.invitee_email = f"invitee-{uuid.uuid4().hex[:8]}@d5021.test"


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


async def _user(uid: uuid.UUID, email: str) -> None:
    await _sql(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        "VALUES (:u,:e,'x','P5021',true,true,0,false,0)", u=uid, e=email,
    )


async def _world() -> World:
    w = World()
    await _sql("INSERT INTO organizations (id, name, slug, plan) VALUES (:o, :n, :s, 'free')", o=w.org, n=f"o5021-{w.org}", s=f"s5021-{w.org}")
    for uid, role in ((w.owner, "owner"), (w.admin, "admin"), (w.plain, "member")):
        await _user(uid, f"{role}-{uid.hex[:8]}@d5021.test")
        await _sql("INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid(), :o, :u, :r)", o=w.org, u=uid, r=role)
    await _user(w.invitee, w.invitee_email)
    return w


async def _cleanup(w: World) -> None:
    for stmt in (
        "DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id = :o)",
        "DELETE FROM members WHERE org_id = :o",
        "DELETE FROM org_members WHERE org_id = :o",
        "DELETE FROM org_invites WHERE organization_id = :o",
        "DELETE FROM organizations WHERE id = :o",
    ):
        await _sql(stmt, o=w.org)
    for u in (w.owner, w.admin, w.plain, w.invitee, w.removed, w.soft_deleted):
        await _sql("DELETE FROM users WHERE id = :u", u=u)


def _ctx(user_id: uuid.UUID, org: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "x@d5021.test"
    ctx.claims = {"app_metadata": {"org_id": str(org)}}
    return ctx


async def _call(w: World, caller: uuid.UUID, method: str, path: str, body: dict | None = None):
    """one request through the real app and the real database, `caller` being the signed-in person"""
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db, get_read_db
    from tests.conftest import override_db_and_read
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    Session = async_sessionmaker(eng, expire_on_commit=False)

    async def override_db():
        async with Session() as s:
            yield s

    async def override_auth():
        return _ctx(caller, w.org)

    override_db_and_read(app, override_db)  # story 2451: get_db and get_read_db always together
    app.dependency_overrides[get_current_user] = override_auth
    try:
        # no e-mail goes out from a test: the send is the one outside effect
        with patch("app.routers.org_invites.send_invite_email", return_value=None):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
                return await c.request(method, path, json=body)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_read_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        await eng.dispose()


def _code(r) -> str | None:
    """the app answers an error as {data: null, error: {code, message}} (the envelope handler); a dict `detail` becomes that error"""
    j = r.json()
    err = j.get("error") if isinstance(j, dict) else None
    if isinstance(err, dict):
        return err.get("code")
    d = j.get("detail") if isinstance(j, dict) else None
    return d.get("code") if isinstance(d, dict) else None


async def _invites(w: World) -> list[tuple]:
    return await _sql("SELECT role, status FROM org_invites WHERE organization_id = :o ORDER BY created_at", o=w.org)


async def _insert_invite(w: World, role: str, created_by: uuid.UUID | None) -> str:
    token = f"t5021-{uuid.uuid4().hex}"
    await _sql(
        "INSERT INTO org_invites (id, organization_id, email, role, token, status, expires_at, created_by, project_ids) "
        "VALUES (gen_random_uuid(), :o, :e, :r, :t, 'pending', :x, :c, '[]'::jsonb)",
        o=w.org, e=w.invitee_email, r=role, t=token, x=datetime.now(timezone.utc) + timedelta(days=7), c=created_by,
    )
    return token


async def _accept(w: World, token: str) -> dict:
    from app.repositories.org_invite import OrgInviteRepository

    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng, expire_on_commit=False)() as s:
            result = await OrgInviteRepository(s).accept(token, w.invitee, w.invitee_email)
            await s.commit()
            return result
    finally:
        await eng.dispose()


async def _role_of_invitee(w: World) -> str | None:
    rows = await _sql("SELECT role FROM org_members WHERE org_id = :o AND user_id = :u", o=w.org, u=w.invitee)
    return rows[0][0] if rows else None


@needs_db
@pytest.mark.anyio
async def test_an_admin_cannot_make_an_owner_invitation_and_so_nobody_becomes_an_owner_through_it():
    """the escalation itself: admin → role=owner → 403 with the same code as changing a member to owner; no invitation row exists, so the invitee can never be made an owner by it"""
    w = await _world()
    try:
        r = await _call(w, w.admin, "POST", f"/api/v2/organizations/{w.org}/invites", {"email": w.invitee_email, "role": "owner"})
        assert r.status_code == 403, r.text
        assert _code(r) == "ORG_MEMBER_OWNER_ONLY_ACTION", r.text
        assert await _invites(w) == []
        assert await _role_of_invitee(w) is None
    finally:
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_a_role_outside_the_three_is_refused_by_the_schema_and_nothing_is_stored():
    w = await _world()
    try:
        for bad in ("superuser", "OWNER", "", "owner ", "Admin", "root"):
            r = await _call(w, w.owner, "POST", f"/api/v2/organizations/{w.org}/invites", {"email": w.invitee_email, "role": bad})
            assert r.status_code == 422, (bad, r.status_code, r.text)
        assert await _invites(w) == []
    finally:
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_who_may_hand_out_what_an_owner_all_three_an_admin_admin_and_member_a_plain_member_nothing():
    w = await _world()
    try:
        url = f"/api/v2/organizations/{w.org}/invites"
        # (caller, role, expected status) — a fresh address each time so «already invited» never answers instead of the rule
        cases = [(w.owner, "owner", 201), (w.owner, "admin", 201), (w.owner, "member", 201), (w.admin, "admin", 201), (w.admin, "member", 201), (w.admin, "owner", 403), (w.plain, "member", 403), (w.plain, "owner", 403)]
        for n, (caller, role, want) in enumerate(cases):
            r = await _call(w, caller, "POST", url, {"email": f"c{n}-{w.invitee_email}", "role": role})
            assert r.status_code == want, (n, role, r.status_code, r.text)
        stored = sorted(x[0] for x in await _invites(w))
        assert stored == sorted(["owner", "admin", "member", "admin", "member"]), stored
    finally:
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_an_invitation_that_already_exists_is_refused_at_accept_when_its_maker_may_not_give_the_role():
    """what was made before the rule (or by someone since demoted · removed): refused at accept — nobody becomes a member through it; the ones that ARE allowed still work"""
    w = await _world()
    try:
        removed = w.removed
        await _user(removed, f"gone-{removed.hex[:8]}@d5021.test")
        await _user(w.soft_deleted, f"soft-{w.soft_deleted.hex[:8]}@d5021.test")
        await _sql("INSERT INTO org_members (id, org_id, user_id, role, deleted_at) VALUES (gen_random_uuid(), :o, :u, 'admin', now())", o=w.org, u=w.soft_deleted)
        refused = {
            "an admin made an owner invitation (the old hole)": ("owner", w.admin),
            "a role that is not one of the three": ("superuser", w.owner),
            "an admin invitation whose maker is only a member now": ("admin", w.plain),
            "an owner invitation whose maker left the organization": ("owner", removed),
            "an owner invitation with no maker (the account was deleted)": ("owner", None),
            "an admin invitation whose maker (an admin) was removed from the organization (the row is soft-deleted)": ("admin", w.soft_deleted),
        }
        for label, (role, maker) in refused.items():
            token = await _insert_invite(w, role, maker)
            result = await _accept(w, token)
            assert result == {"ok": False, "reason": "invalid_role"}, (label, result)
            assert await _role_of_invitee(w) is None, label
            await _sql("DELETE FROM org_invites WHERE token = :t", t=token)
        # allowed: an owner's owner invitation · an admin's admin invitation · a member invitation whoever made it (or nobody)
        for role, maker, becomes in (("owner", w.owner, "owner"), ("admin", w.admin, "admin"), ("member", None, "member")):
            token = await _insert_invite(w, role, maker)
            result = await _accept(w, token)
            assert result["ok"] is True and result["role"] == becomes, (role, result)
            assert await _role_of_invitee(w) == becomes
            await _sql("DELETE FROM members WHERE org_id = :o", o=w.org)  # the accept also makes the person's anchor row: start the next round clean
            await _sql("DELETE FROM org_members WHERE org_id = :o AND user_id = :u", o=w.org, u=w.invitee)
            await _sql("DELETE FROM org_invites WHERE token = :t", t=token)
    finally:
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_an_accepted_invitation_cannot_be_replayed_to_get_the_role_back_when_its_maker_may_not_give_it():
    """the «already accepted» branch of accept makes the membership again for the same address (a double click · a person who left and comes back): for a person who is NOT a member now it asks the maker rule too;
    a person who IS a member (a double click) just hears ok"""
    w = await _world()
    try:
        # an owner invitation an ADMIN made (the old hole), already accepted once by an earlier account; the same address (a new account) replays it
        token = await _insert_invite(w, "owner", w.admin)
        await _sql("UPDATE org_invites SET status = 'accepted', accepted_at = now() WHERE token = :t", t=token)
        assert await _accept(w, token) == {"ok": False, "reason": "invalid_role"}
        assert await _role_of_invitee(w) is None
        # the same shape but a legitimate owner invitation: the replay still works (a person who left and comes back)
        ok_token = await _insert_invite(w, "owner", w.owner)
        await _sql("UPDATE org_invites SET status = 'accepted', accepted_at = now() WHERE token = :t", t=ok_token)
        result = await _accept(w, ok_token)
        assert result["ok"] is True and await _role_of_invitee(w) == "owner"
        # and a person who is already a member double-clicking an invitation whose maker has since been demoted just hears ok (and keeps what they have)
        await _sql("UPDATE org_members SET role = 'member' WHERE org_id = :o AND user_id = :u", o=w.org, u=w.owner)
        again = await _accept(w, ok_token)
        assert again["ok"] is True
    finally:
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_an_accept_waits_for_a_demotion_of_the_maker_that_is_not_committed_yet_and_then_refuses():
    """the race: the maker (an admin) is being demoted in another transaction while the invitation they made is accepted. Without a lock the accept reads the OLD role (still committed) and gives admin
    after the demotion; with the share lock on the maker's row it waits for the demotion, reads the new role and refuses."""
    import asyncio

    w = await _world()
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        token = await _insert_invite(w, "admin", w.admin)
        async with async_sessionmaker(eng)() as demote:
            await demote.execute(text("UPDATE org_members SET role = 'member' WHERE org_id = :o AND user_id = :u"), {"o": w.org, "u": w.admin})  # not committed: the row is locked
            accept = asyncio.create_task(_accept(w, token))
            done, _ = await asyncio.wait({accept}, timeout=2.0)
            assert not done, "the accept did not wait for the uncommitted demotion of its maker (it read the old role)"
            await demote.commit()
        result = await asyncio.wait_for(accept, 20)
        assert result == {"ok": False, "reason": "invalid_role"}, result
        assert await _role_of_invitee(w) is None
    finally:
        await eng.dispose()
        await _cleanup(w)


@needs_db
@pytest.mark.anyio
async def test_the_accept_route_answers_a_refused_role_with_a_clear_403_and_makes_no_member():
    w = await _world()
    try:
        token = await _insert_invite(w, "owner", w.admin)
        r = await _call(w, w.invitee, "POST", "/api/v2/invites/accept", {"token": token})
        assert r.status_code == 403, r.text
        assert _code(r) == "INVITE_ROLE_NOT_ALLOWED", r.text
        assert await _role_of_invitee(w) is None
        # the by-id route (an invitation listed for the person) answers the same way — it goes through the same accept
    finally:
        await _cleanup(w)


def test_the_schema_literal_is_the_organization_role_list_and_the_rule_table_is_what_the_docstring_says():
    from typing import get_args

    from app.schemas.org_invite import CreateOrgInvite
    from app.schemas.org_member import ORG_ROLES
    from app.services.org_role_policy import can_grant_org_role

    assert set(get_args(CreateOrgInvite.model_fields["role"].annotation)) == set(ORG_ROLES)
    table = {("owner", "owner"): True, ("owner", "admin"): True, ("owner", "member"): True, ("admin", "owner"): False, ("admin", "admin"): True, ("admin", "member"): True,
             ("member", "member"): False, ("member", "owner"): False, (None, "member"): False, (None, "owner"): False, ("owner", "superuser"): False, ("admin", None): False, ("owner", None): False}
    for (granter, target), want in table.items():
        assert can_grant_org_role(granter, target) is want, (granter, target)
