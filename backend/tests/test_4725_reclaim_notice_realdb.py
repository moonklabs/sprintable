"""story 4725 decision 2 — the person whose unproved account was reclaimed is told, ONCE, what was cut.

The reclaim (`_reclaim_unproved_account`) writes, in its own transaction, what it REALLY cut — `users.reclaim_notice` = {"cut": [...], "password_cleared": bool} and
nothing else — `GET /auth/me` answers it as `reclaim_notice`, and the person's own `POST /auth/reclaim-notice/dismiss` sets it back to NULL. Server-side, so every road
in (the web's cookie session, the apps' hand-over code, a mailed link) shows the same thing; nothing rides in a cookie or an address.

Real HTTP over a migrated PG.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

PASSWORD = "Squatter!Passw0rd-4725n"
NEW_PASSWORD = "Owner!NewPassw0rd-4725n"
EMAILS = ("victim@d4725n.test", "other@d4725n.test", "nothing@d4725n.test", "provider-made@d4725n.test", "plain@d4725n.test")
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


_CLEAN = [
    f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email IN ({_MAILS}))",
    f"DELETE FROM login_audit_logs WHERE email IN ({_MAILS}) OR user_id IN (SELECT id FROM users WHERE email IN ({_MAILS}))",
    f"DELETE FROM auth_migrations WHERE user_id IN (SELECT id FROM users WHERE email IN ({_MAILS}))",
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


async def _register(c, email: str) -> dict:
    r = await c.post("/api/v2/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Squatter", "tos_accepted": True})
    assert r.status_code == 201, r.text
    return r.json().get("data", r.json())


async def _callback(c, monkeypatch, *, provider: str, sub: str, email: str, verified: bool):
    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(sub, email, verified)))
    return await c.post("/api/v2/auth/oauth/callback", json={"provider": provider, "code": "c", "state": create_oauth_state_token(provider), "tos_accepted": True})


def _auth(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def _data(r) -> dict:
    return r.json().get("data", r.json())


async def _notice(c, tokens: dict):
    me = await c.get("/api/v2/auth/me", headers=_auth(tokens))
    assert me.status_code == 200, me.text
    return _data(me)["reclaim_notice"]


async def _stored(email: str):
    return (await _rows(f"SELECT reclaim_notice FROM users WHERE email = '{email}'"))[0][0]


@pytest.mark.anyio
async def test_a_reclaim_tells_the_owner_what_was_cut_once(world, monkeypatch):
    """a squatter's password account (a live session, an Apple identity, a two-factor secret) reclaimed by a verified Google login: the owner's first /me names what
    was really cut — and says the password was cleared — and after the owner closes it, it never comes back"""
    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        await _sql(f"UPDATE users SET apple_id = 'squatter-apple', totp_enabled = true, totp_secret = 'SQUATTERSECRET' WHERE email = '{email}'")
        r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
        owner = _data(r)
        assert await _notice(c, owner) == {"cut": ["sessions", "providers", "two_step"], "password_cleared": True}
        assert await _notice(c, owner) == {"cut": ["sessions", "providers", "two_step"], "password_cleared": True}   # asking does not clear it
        d = await c.post("/api/v2/auth/reclaim-notice/dismiss", headers=_auth(owner))
        assert d.status_code == 200, d.text
        assert await _notice(c, owner) is None
        assert await _stored(email) is None
        # the owner's later sign-ins do not bring it back
        again = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert again.status_code == 200
        assert await _notice(c, _data(again)) is None


@pytest.mark.anyio
async def test_keys_phones_and_computers_the_squatter_made_are_named_when_they_were_cut(world, monkeypatch):
    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
    uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
    org, proj, hm = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    setup = uuid.uuid4()
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','Sq Co','d4725n-{org.hex[:8]}','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{proj}','{org}','P')",
        f"INSERT INTO members (id,org_id,type,user_id) VALUES ('{hm}','{org}','human','{uid}')",
        f"INSERT INTO human_api_keys (id,member_id,name,key_prefix,key_hash) VALUES ('{uuid.uuid4()}','{hm}','mine','hu1','hh1-{org.hex}')",
        f"INSERT INTO project_api_keys (id,project_id,created_by,name,key_prefix,key_hash) VALUES ('{uuid.uuid4()}','{proj}','{uid}','mine','p1','ph1-{org.hex}')",
        f"INSERT INTO remote_devices (id,member_id,org_id,label,public_key,fingerprint) VALUES ('{uuid.uuid4()}','{hm}','{org}','mine','pk1','fp-{org.hex}-1')",
        f"INSERT INTO desktop_setups (id,code_hash,code_challenge,device_name,expires_at,confirmed_by) VALUES ('{setup}','c1-{org.hex}','ch1','mine',now()+interval '1 day','{uid}')",
        f"INSERT INTO auth_identities (id,user_id,issuer,subject) VALUES ('{uuid.uuid4()}','{uid}','https://securetoken.example/p','squatter-fb-sub-n')",
    )
    try:
        async with _client() as c:
            r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
            assert r.status_code == 200, r.text
            assert await _notice(c, _data(r)) == {"cut": ["sessions", "providers", "keys", "phones", "computers"], "password_cleared": True}
    finally:
        await _sql(
            f"DELETE FROM human_api_keys WHERE member_id = '{hm}'",
            f"DELETE FROM auth_identities WHERE user_id = '{uid}'",
            f"DELETE FROM desktop_setups WHERE id = '{setup}'",
            f"DELETE FROM remote_devices WHERE org_id = '{org}'",
            f"DELETE FROM project_api_keys WHERE project_id = '{proj}'",
            f"DELETE FROM members WHERE org_id = '{org}'",
            f"DELETE FROM projects WHERE id = '{proj}'",
            f"DELETE FROM organizations WHERE id = '{org}'",
        )


@pytest.mark.anyio
async def test_nothing_cut_means_no_notice(world, monkeypatch):
    """a «cut» that cut nothing would be false: an unverified provider-made account with no sign-in, no identity, no password, no two-factor, no keys is proved
    — the account is verified and there is nothing to tell"""
    email = "nothing@d4725n.test"
    async with _client() as c:
        first = await _callback(c, monkeypatch, provider="google", sub="gone-sub", email=email, verified=False)
        assert first.status_code == 200, first.text
        await _sql(
            f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '{email}')",
            f"UPDATE users SET google_id = NULL WHERE email = '{email}'",
        )
        r = await _callback(c, monkeypatch, provider="google", sub="owner-google", email=email, verified=True)   # (Apple never matches by e-mail)
        assert r.status_code == 200, r.text
        assert (await _rows(f"SELECT email_verified FROM users WHERE email = '{email}'"))[0][0] is True
        assert await _notice(c, _data(r)) is None
        assert await _stored(email) is None


@pytest.mark.anyio
async def test_an_account_that_was_never_reclaimed_has_no_notice(world):
    email = "plain@d4725n.test"
    async with _client() as c:
        tokens = await _register(c, email)
        assert await _notice(c, tokens) is None


@pytest.mark.anyio
async def test_another_persons_session_cannot_clear_it(world, monkeypatch):
    victim, other = "victim@d4725n.test", "other@d4725n.test"
    async with _client() as c:
        await _register(c, victim)
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=victim, verified=True))
        stranger = await _register(c, other)
        assert (await c.post("/api/v2/auth/reclaim-notice/dismiss", headers=_auth(stranger))).status_code == 200      # clears only the stranger's own (nothing)
        assert await _notice(c, owner) is not None                                                                       # … the owner's is still there
        assert (await c.post("/api/v2/auth/reclaim-notice/dismiss")).status_code == 401                                 # no session at all


@pytest.mark.anyio
async def test_a_session_older_than_the_cut_off_that_was_already_inside_cannot_clear_it(world, monkeypatch):
    """codex 01a14803: a request admitted just BEFORE the reclaim passed the per-request check and then waited for the row; once the reclaim committed it must not erase the
    notice. The route checks the session against the cut-off again under the row lock — here the route is called directly with the squatter's pre-reclaim `iat`"""
    from fastapi import HTTPException

    from app.core.database import async_session_factory
    from app.dependencies.auth import AuthContext
    from app.routers.auth import dismiss_reclaim_notice

    email = "victim@d4725n.test"
    async with _client() as c:
        squat = await _register(c, email)
        from jose import jwt as _jwt
        old_iat = _jwt.get_unverified_claims(squat["access_token"])["iat"]
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True))
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        auth = AuthContext(user_id=str(uid), email=email, claims={"app_metadata": {}, "iat": old_iat})
        async with async_session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await dismiss_reclaim_notice(session=session, auth=auth)
            assert exc.value.status_code == 401
        assert await _notice(c, owner) is not None


@pytest.mark.anyio
async def test_a_session_without_iat_such_as_firebase_can_clear_its_own_notice(world, monkeypatch):
    """codex 01a14882: a Firebase session context carries no `iat` (its `auth_time` was checked by its resolver); the dismissal must not 401 a legitimate person"""
    from app.core.database import async_session_factory
    from app.dependencies.auth import AuthContext
    from app.routers.auth import dismiss_reclaim_notice

    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True))
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        auth = AuthContext(user_id=str(uid), email=email, claims={"auth_issuer": "https://securetoken.example/p", "auth_time": int(time.time()) + 5, "app_metadata": {}})
        async with async_session_factory() as session:
            r = await dismiss_reclaim_notice(session=session, auth=auth)
            assert r.status_code == 200
        assert await _notice(c, owner) is None


@pytest.mark.anyio
async def test_a_firebase_session_older_than_the_cut_off_cannot_clear_it(world, monkeypatch):
    """the same re-check by `auth_time` for a session that has no `iat` (Kadir's recommendation 1)"""
    from fastapi import HTTPException

    from app.core.database import async_session_factory
    from app.dependencies.auth import AuthContext
    from app.routers.auth import dismiss_reclaim_notice

    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True))
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        auth = AuthContext(user_id=str(uid), email=email, claims={"auth_issuer": "https://securetoken.example/p", "auth_time": int(time.time()) - 3600, "app_metadata": {}})
        async with async_session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await dismiss_reclaim_notice(session=session, auth=auth)
            assert exc.value.status_code == 401
        assert await _notice(c, owner) is not None


@pytest.mark.anyio
async def test_an_already_unlinked_identity_is_not_named_as_cut(world, monkeypatch):
    email = "nothing@d4725n.test"
    async with _client() as c:
        first = await _callback(c, monkeypatch, provider="google", sub="gone-sub", email=email, verified=False)
        assert first.status_code == 200, first.text
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        await _sql(
            f"DELETE FROM refresh_tokens WHERE user_id = '{uid}'",
            f"UPDATE users SET google_id = NULL WHERE id = '{uid}'",
            f"INSERT INTO auth_identities (id,user_id,issuer,subject,unlinked_at) VALUES ('{uuid.uuid4()}','{uid}','https://securetoken.example/p','old-sub-n',now())",
        )
        r = await _callback(c, monkeypatch, provider="google", sub="owner-google", email=email, verified=True)
        assert r.status_code == 200, r.text
        assert await _notice(c, _data(r)) is None
        assert (await _rows(f"SELECT count(*) FROM auth_identities WHERE user_id = '{uid}'"))[0][0] == 0


@pytest.mark.anyio
async def test_a_key_session_cannot_clear_it(world, monkeypatch):
    """a personal API key or an agent key is not the person at the screen: 403, and the mark stays"""
    from app.core.security import create_tokens
    import time

    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True))
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        for claim in ("human_api_key_id", "api_key_id"):
            time.sleep(0)  # (tokens made after the cut-off: iat >= the reclaim's second + 1 — the owner's callback waited for it)
            keyed = create_tokens(str(uid), email=email, app_metadata={claim: str(uuid.uuid4())}, session_started_at=int(time.time()))
            r = await c.post("/api/v2/auth/reclaim-notice/dismiss", headers=_auth(keyed))
            assert r.status_code == 403, (claim, r.status_code, r.text)
        assert await _notice(c, owner) is not None


@pytest.mark.anyio
async def test_the_mailed_reset_and_the_mail_verification_roads_leave_the_same_notice(world, monkeypatch):
    from app.core.security import create_email_verification_token, create_password_reset_token

    async with _client() as c:
        # a mailed reset of a provider-made unverified account with a two-factor secret: the NEW password is set, so the password is not «cleared»
        reset_email = "provider-made@d4725n.test"
        await _callback(c, monkeypatch, provider="google", sub="squatter-sub", email=reset_email, verified=False)
        await _sql(f"UPDATE users SET totp_enabled = true, totp_secret = 'SQUATTERSECRET' WHERE email = '{reset_email}'")
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{reset_email}'"))[0][0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), ""), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        assert await _stored(reset_email) == {"cut": ["sessions", "providers", "two_step"], "password_cleared": False}
        await asyncio.sleep(1.1)   # a sign-in in the SAME second as the reclaim is refused by the cut-off (a known, written residual); a person types slower
        login = await c.post("/api/v2/auth/token", json={"email": reset_email, "password": NEW_PASSWORD})
        assert login.status_code == 200, login.text
        assert await _notice(c, _data(login)) == {"cut": ["sessions", "providers", "two_step"], "password_cleared": False}

        # the mail-verification road of another provider-made account
        verify_email = "nothing@d4725n.test"
        await _callback(c, monkeypatch, provider="google", sub="squatter2-sub", email=verify_email, verified=False)
        uid2 = (await _rows(f"SELECT id FROM users WHERE email = '{verify_email}'"))[0][0]
        r = await c.get("/api/v2/auth/verify-email", params={"token": create_email_verification_token(str(uid2))})
        assert r.status_code == 200, r.text
        assert await _stored(verify_email) == {"cut": ["sessions", "providers"], "password_cleared": False}


@pytest.mark.anyio
async def test_a_mailed_reset_that_sets_a_new_password_does_not_say_the_password_was_cleared(world, monkeypatch):
    """Kadir's surviving mutant: an unverified account WITH a password, reclaimed by the mailed reset that sets the new one — the password is replaced, not cleared"""
    from app.core.security import create_password_reset_token

    email = "plain@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        uid, stored = (await _rows(f"SELECT id, hashed_password FROM users WHERE email = '{email}'"))[0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), stored), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        assert await _stored(email) == {"cut": ["sessions"], "password_cleared": False}


@pytest.mark.anyio
async def test_a_personal_api_key_session_is_not_told(world, monkeypatch):
    """Kadir's recommendation 2: /auth/me gives the notice to a person at a screen only (the model comment says «none for an API-key context»)"""
    from app.core.security import create_tokens

    email = "victim@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        owner = _data(await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True))
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        await asyncio.sleep(1.1)
        keyed = create_tokens(str(uid), email=email, app_metadata={"human_api_key_id": str(uuid.uuid4())}, session_started_at=int(time.time()))
        me = await c.get("/api/v2/auth/me", headers=_auth(keyed))
        assert me.status_code == 200, me.text
        assert _data(me)["reclaim_notice"] is None
        assert await _notice(c, owner) is not None


@pytest.mark.anyio
async def test_an_already_proved_account_gets_no_notice_from_a_login(world, monkeypatch):
    email = "plain@d4725n.test"
    async with _client() as c:
        await _register(c, email)
        await _sql(f"UPDATE users SET email_verified = true WHERE email = '{email}'")
        r = await _callback(c, monkeypatch, provider="google", sub="my-google", email=email, verified=True)
        assert r.status_code == 200, r.text
        assert await _notice(c, _data(r)) is None
