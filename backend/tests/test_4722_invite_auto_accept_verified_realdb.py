"""story 4722 — a pending invite is turned into a membership at sign-in / sign-up only for an account whose MAILBOX was proved.

`_build_app_metadata` finds a pending invite by the user's e-mail address and accepts it. Before this story the only conditions were
address · pending · not expired — an address typed into the sign-up form proves nothing about who reads that mailbox, so anyone could
register another person's invited address and become a member of the inviting organization. Now the fallback runs only when
`users.email_verified` (the verify-mail link, or an OAuth provider that said the address is verified); the invite LINK (a token the
invitee holds) is the other proof and goes through `invite_token` / `POST /api/v2/invites/accept`, not through this fallback.

Real HTTP over a migrated PG, all four roads that call `_build_app_metadata`: sign-up · sign-in · OAuth callback · refresh of a person with
no organization — each one answers the same way (one function decides).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d4722000-0000-0000-0000-00000000000a")
PASSWORD = "Str0ng!Passw0rd-4722"
TOK = {name: f"d4722{name}".ljust(64, "0") for name in ("main", "expired", "other", "link")}
EMAILS = ("signup@d4722.test", "login-unv@d4722.test", "login-ver@d4722.test", "refresh@d4722.test", "oauth-ok@d4722.test",
          "oauth-no@d4722.test", "link@d4722.test", "stranger@d4722.test")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _no_rate_limit_and_no_mail(monkeypatch):
    from app.core.rate_limit import limiter

    was = limiter.enabled
    limiter.enabled = False
    monkeypatch.setattr("app.services.email.send_email", lambda *a, **k: True)
    yield
    limiter.enabled = was


async def _sql(*stmts: str):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            for st in stmts:
                await s.execute(text(st))
            await s.commit()
    finally:
        await eng.dispose()


async def _rows(q: str) -> list[tuple]:
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            return [tuple(r) for r in (await s.execute(text(q))).all()]
    finally:
        await eng.dispose()


_MAILS = ",".join(f"'{e}'" for e in EMAILS)
_CLEAN = [
    f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ({_MAILS}))",
    f"DELETE FROM org_invites WHERE organization_id = '{ORG}'",
    f"DELETE FROM project_access WHERE org_member_id IN (SELECT id FROM org_members WHERE org_id = '{ORG}')",
    f"DELETE FROM members WHERE org_id = '{ORG}'",
    f"DELETE FROM org_members WHERE org_id = '{ORG}'",
    f"DELETE FROM login_audit_logs WHERE email IN ({_MAILS})",
    f"DELETE FROM users WHERE email IN ({_MAILS})",
    f"DELETE FROM organizations WHERE id = '{ORG}'",
]


def _invite(email: str, token: str, *, expires: str = "now() + interval '7 days'", status: str = "pending") -> str:
    return ("INSERT INTO org_invites (id,organization_id,email,role,token,status,expires_at,created_at) VALUES "
            f"(gen_random_uuid(),'{ORG}','{email}','member','{token}','{status}',{expires},now())")


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','Delta Co','d4722-a','free')",
        # one pending invite per address that the roads below use
        *[_invite(e, TOK["main"] if i == 0 else f"d4722{i}".ljust(64, "0")) for i, e in enumerate(
            ("signup@d4722.test", "login-unv@d4722.test", "login-ver@d4722.test", "refresh@d4722.test", "oauth-ok@d4722.test", "oauth-no@d4722.test"))],
        _invite("link@d4722.test", TOK["link"]),
    )
    yield
    await _sql(*_CLEAN)


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _make_user(email: str, *, verified: bool) -> uuid.UUID:
    from app.core.security import hash_password

    uid = uuid.uuid4()
    await _sql(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{uid}','{email}','{hash_password(PASSWORD)}','T',true,{'true' if verified else 'false'},0,false,0)",
    )
    return uid


def _claims(r) -> dict:
    from jose import jwt

    data = r.json().get("data", r.json())
    return jwt.get_unverified_claims(data["access_token"])


async def _members(email: str) -> int:
    return (await _rows(
        "SELECT count(*) FROM org_members om JOIN users u ON u.id = om.user_id "
        f"WHERE om.org_id = '{ORG}' AND u.email = '{email}' AND om.deleted_at IS NULL"
    ))[0][0]


async def _invite_status(email: str) -> str:
    return (await _rows(f"SELECT status FROM org_invites WHERE organization_id = '{ORG}' AND email = '{email}'"))[0][0]


def _joined_the_org(claims: dict) -> bool:
    return str((claims.get("app_metadata") or {}).get("org_id") or "") == str(ORG)


# ── road 1: sign-up ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_signup_with_an_address_nobody_proved_does_not_join_the_invited_org(world):
    email = "signup@d4722.test"
    async with _client() as c:
        r = await c.post("/api/v2/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Mallory", "tos_accepted": True})
    assert r.status_code == 201, r.text
    assert not _joined_the_org(_claims(r))
    assert await _members(email) == 0
    assert await _invite_status(email) == "pending"          # the invitation is still there for its real owner


@pytest.mark.anyio
async def test_signup_carrying_the_invite_link_token_joins(world):
    """the invite LINK is the other proof: the token went to that mailbox"""
    email = "link@d4722.test"
    async with _client() as c:
        r = await c.post("/api/v2/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Invitee", "tos_accepted": True,
                                                        "invite_token": TOK["link"]})
    assert r.status_code == 201, r.text
    assert await _members(email) == 1
    assert await _invite_status(email) == "accepted"


# ── road 2: sign-in ────────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_login_of_an_unverified_account_leaves_the_invite_pending(world):
    email = "login-unv@d4722.test"
    await _make_user(email, verified=False)
    async with _client() as c:
        r = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert not _joined_the_org(_claims(r))
    assert await _members(email) == 0
    assert await _invite_status(email) == "pending"


@pytest.mark.anyio
async def test_login_of_a_verified_account_joins(world):
    email = "login-ver@d4722.test"
    await _make_user(email, verified=True)
    async with _client() as c:
        r = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert _joined_the_org(_claims(r))
    assert await _members(email) == 1
    assert await _invite_status(email) == "accepted"


# ── road 3: OAuth callback ─────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
@pytest.mark.parametrize(("email", "provider_says_verified", "joins"), [
    ("oauth-ok@d4722.test", True, True),    # AC2: the provider said the address is verified → the new account is verified → joins
    ("oauth-no@d4722.test", False, False),  # the provider did NOT say so (an unverified address) → not verified → the invite stays pending
])
async def test_oauth_callback_follows_the_providers_own_verified_claim(world, monkeypatch, email, provider_says_verified, joins):
    from unittest.mock import AsyncMock

    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(f"g-{email}", email, provider_says_verified)))
    async with _client() as c:
        r = await c.post("/api/v2/auth/oauth/callback", json={"provider": "google", "code": "c", "state": create_oauth_state_token("google"),
                                                               "tos_accepted": True})
    assert r.status_code == 200, r.text
    assert (await _rows(f"SELECT email_verified FROM users WHERE email = '{email}'"))[0][0] is provider_says_verified
    assert _joined_the_org(_claims(r)) is joins
    assert await _members(email) == (1 if joins else 0)
    assert await _invite_status(email) == ("accepted" if joins else "pending")


def test_the_providers_claim_is_read_strictly():
    """only an explicit true counts: a boolean (Google) or exactly the string "true" (Apple); absent · false · other strings → not verified"""
    from app.routers.auth import _provider_says_verified as v

    assert v({"email_verified": True}) and v({"email_verified": "true"})
    for bad in ({}, {"email_verified": False}, {"email_verified": "false"}, {"email_verified": "1"}, {"email_verified": 1}, {"email_verified": None},
                {"email_verified": "yes"}, {"email_verified": " TRUE "}, {"email_verified": "True"}, {"email_verified": "TRUE"}):
        assert not v(bad), bad


# ── road 4: refresh of a person with no organization ───────────────────────────────────────────────
@pytest.mark.anyio
async def test_refresh_of_a_person_with_no_org_follows_the_flag_at_that_moment(world):
    email = "refresh@d4722.test"
    uid = await _make_user(email, verified=False)
    async with _client() as c:
        login = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
        assert login.status_code == 200, login.text
        refresh = (login.json().get("data", login.json()))["refresh_token"]
        assert await _members(email) == 0
        r1 = await c.post("/api/v2/auth/refresh", json={"refresh_token": refresh})
        assert r1.status_code == 200, r1.text
        assert not _joined_the_org(_claims(r1)) and await _members(email) == 0          # still unproved → still pending
        # the person proves the mailbox (the verify-mail link sets exactly this) → the very next refresh brings the invitation in
        await _sql(f"UPDATE users SET email_verified = true WHERE id = '{uid}'")
        refresh2 = (r1.json().get("data", r1.json()))["refresh_token"]
        r2 = await c.post("/api/v2/auth/refresh", json={"refresh_token": refresh2})
        assert r2.status_code == 200, r2.text
    assert await _members(email) == 1
    assert _joined_the_org(_claims(r2))


# ── the real web journey (codex 01a146c7): sign up WITHOUT the token → the invite page accepts WITH the token → the same session works ────
@pytest.mark.anyio
async def test_signup_then_accept_on_the_invite_page_then_the_rotated_session_has_the_organization(world):
    """the web register form does not carry `invite_token`; the invitee lands on the invite page next and POSTs the token with the session the sign-up made.
    That session's token has no organization (the address is not proved yet) and `/me` finds none until the session is rotated — the web BFF accept route
    rotates it in the same response (apps/web api/invites/[token]/accept/route.ts). The server half of that contract: after a token accept, a refresh of
    that session yields a token that names the organization, and `/me` answers with it."""
    email = "signup@d4722.test"
    async with _client() as c:
        reg = await c.post("/api/v2/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Invitee", "tos_accepted": True})
        assert reg.status_code == 201, reg.text
        data = reg.json().get("data", reg.json())
        assert not _joined_the_org(_claims(reg))
        bearer = {"Authorization": f"Bearer {data['access_token']}"}
        assert (await c.get("/api/v2/me", headers=bearer)).status_code == 404              # the org-less session, as the web layout sees it
        acc = await c.post("/api/v2/invites/accept", json={"token": TOK["main"]}, headers=bearer)
        assert acc.status_code == 200, acc.text
        assert await _members(email) == 1
        rotated = await c.post("/api/v2/auth/refresh", json={"refresh_token": data["refresh_token"]})
        assert rotated.status_code == 200, rotated.text
        assert _joined_the_org(_claims(rotated))
        me = await c.get("/api/v2/me", headers={"Authorization": f"Bearer {(rotated.json().get('data', rotated.json()))['access_token']}"})
    assert me.status_code == 200, me.text
    assert str(me.json().get("org_id") or (me.json().get("data") or {}).get("org_id")) == str(ORG)


# ── the accept must really have happened ────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_a_refused_accept_leaves_no_org_context_in_the_token(world, monkeypatch):
    """codex 01a146b6: the fallback used to return the organization even when `accept()` refused (an invite revoked between the lookup and the accept)"""
    from app.repositories.org_invite import OrgInviteRepository

    async def refused(self, token, user_id, user_email):
        return {"ok": False, "reason": "invalid_status"}

    monkeypatch.setattr(OrgInviteRepository, "accept", refused)
    email = "login-ver@d4722.test"
    await _make_user(email, verified=True)
    async with _client() as c:
        r = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert not _joined_the_org(_claims(r))
    assert await _members(email) == 0


# ── no way in around it ────────────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
@pytest.mark.parametrize(("label", "invite_sql", "email"), [
    ("expired", _invite("stranger@d4722.test", TOK["expired"], expires="now() - interval '1 minute'"), "stranger@d4722.test"),
    ("someone else's address", _invite("someone-else@d4722.test", TOK["other"]), "stranger@d4722.test"),
])
async def test_even_a_verified_account_gets_nothing_from_an_expired_or_another_persons_invite(world, label, invite_sql, email):
    await _sql(invite_sql)
    await _make_user(email, verified=True)
    async with _client() as c:
        r = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    assert not _joined_the_org(_claims(r)), label
    assert await _members(email) == 0, label


def test_one_function_decides_and_the_fallback_calls_it():
    """AC1 «one place»: the fallback branch is gated by pending_invite_auto_accept_allowed, nothing else in auth.py reads the pending-invite table to accept"""
    import inspect

    import app.routers.auth as auth_router

    src = inspect.getsource(auth_router._build_app_metadata)
    assert "pending_invite_auto_accept_allowed(user)" in src
    assert auth_router.pending_invite_auto_accept_allowed(type("U", (), {"email_verified": True})()) is True
    assert auth_router.pending_invite_auto_accept_allowed(type("U", (), {"email_verified": False})()) is False
    assert auth_router.pending_invite_auto_accept_allowed(type("U", (), {})()) is False       # no flag at all → not proved
