"""story 4724 — the OAuth callback may tie a provider identity to an EXISTING account by e-mail only when the PROVIDER vouched for that address.

`oauth_callback` looks the user up by provider id first, then by e-mail. The e-mail match used to link the provider id and issue a token
whatever the provider said about the address: whoever controls a provider account that carries someone else's address UNVERIFIED would
get that person's account. Now the e-mail match needs the provider's own `email_verified` (true / "true"); otherwise: `OAUTH_EMAIL_NOT_VERIFIED`
(403), nothing linked, no token. An identity that is already linked (matched by provider id) is unchanged; a NEW account with an unverified
provider address is still created (it equates nothing) with `email_verified=false`; Apple never matches by e-mail.

Real HTTP over a migrated PG.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

EMAILS = ("victim@d4724.test", "linked@d4724.test", "fresh@d4724.test", "verified-link@d4724.test", "apple-existing@d4724.test")
_MAILS = ",".join(f"'{e}'" for e in EMAILS)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _no_rate_limit():
    from app.core.rate_limit import limiter

    was = limiter.enabled
    limiter.enabled = False
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


_CLEAN = [
    f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ({_MAILS}))",
    f"DELETE FROM login_audit_logs WHERE email IN ({_MAILS})",
    f"DELETE FROM users WHERE email IN ({_MAILS})",
]


@pytest.fixture
async def world():
    await _sql(*_CLEAN)
    yield
    await _sql(*_CLEAN)


def _client():
    import httpx

    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _make_user(email: str, *, verified: bool, google_id: str | None = None) -> uuid.UUID:
    uid = uuid.uuid4()
    gid = f"'{google_id}'" if google_id else "NULL"
    await _sql(
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count,google_id) VALUES "
        f"('{uid}','{email}','',' E',true,{'true' if verified else 'false'},0,false,0,{gid})",
    )
    return uid


async def _callback(monkeypatch, *, provider: str, sub: str, email: str, provider_says_verified: bool):
    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(sub, email, provider_says_verified)))
    async with _client() as c:
        return await c.post("/api/v2/auth/oauth/callback", json={"provider": provider, "code": "c", "state": create_oauth_state_token(provider),
                                                                  "tos_accepted": True})


async def _google_id(email: str):
    return (await _rows(f"SELECT google_id FROM users WHERE email = '{email}'"))[0][0]


async def _refresh_count(email: str) -> int:
    return (await _rows(f"SELECT count(*) FROM refresh_tokens r JOIN users u ON u.id = r.user_id WHERE u.email = '{email}'"))[0][0]


@pytest.mark.anyio
@pytest.mark.parametrize("account_verified", [True, False])
async def test_an_unverified_provider_address_does_not_reach_an_existing_account(world, monkeypatch, account_verified):
    email = "victim@d4724.test"
    await _make_user(email, verified=account_verified)
    r = await _callback(monkeypatch, provider="google", sub="attacker-sub", email=email, provider_says_verified=False)
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "OAUTH_EMAIL_NOT_VERIFIED"
    assert "access_token" not in r.text and "refresh_token" not in r.text
    assert await _google_id(email) is None                  # nothing linked
    assert await _refresh_count(email) == 0                 # no session made


@pytest.mark.anyio
async def test_a_verified_provider_address_links_the_existing_account(world, monkeypatch):
    email = "verified-link@d4724.test"
    await _make_user(email, verified=True)
    r = await _callback(monkeypatch, provider="google", sub="real-owner-sub", email=email, provider_says_verified=True)
    assert r.status_code == 200, r.text
    assert await _google_id(email) == "real-owner-sub"
    assert await _refresh_count(email) == 1


@pytest.mark.anyio
async def test_an_identity_already_linked_signs_in_as_before_whatever_the_claim_says(world, monkeypatch):
    """matched by the provider id, not by the e-mail text: the first lookup — unchanged"""
    email = "linked@d4724.test"
    await _make_user(email, verified=True, google_id="known-sub")
    r = await _callback(monkeypatch, provider="google", sub="known-sub", email=email, provider_says_verified=False)
    assert r.status_code == 200, r.text
    assert await _google_id(email) == "known-sub"
    assert await _refresh_count(email) == 1


@pytest.mark.anyio
async def test_a_new_account_with_an_unverified_provider_address_is_still_created_but_not_verified(world, monkeypatch):
    """the decision for the other branch: a fresh identity equates nothing — it exists, held back from what a proved mailbox unlocks"""
    email = "fresh@d4724.test"
    r = await _callback(monkeypatch, provider="google", sub="fresh-sub", email=email, provider_says_verified=False)
    assert r.status_code == 200, r.text
    assert (await _rows(f"SELECT email_verified, google_id FROM users WHERE email = '{email}'"))[0] == (False, "fresh-sub")


@pytest.mark.anyio
@pytest.mark.parametrize("provider_says_verified", [True, False])
async def test_apple_never_matches_an_existing_account_by_email(world, monkeypatch, provider_says_verified):
    """story 3118: Apple always creates (a relay address is not a reliable key) → the existing e-mail is a conflict, not a link"""
    email = "apple-existing@d4724.test"
    await _make_user(email, verified=True)
    r = await _callback(monkeypatch, provider="apple", sub="apple-sub", email=email, provider_says_verified=provider_says_verified)
    assert r.status_code == 409, r.text
    assert (await _rows(f"SELECT apple_id FROM users WHERE email = '{email}'"))[0][0] is None
    assert await _refresh_count(email) == 0
