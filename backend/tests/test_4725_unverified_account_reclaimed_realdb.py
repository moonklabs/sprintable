"""story 4725 — when a mailbox is PROVED for an account that had not been proved before, what the account held from before the proof is dropped.

The earlier story (4724) stops an UNVERIFIED provider address from reaching an existing account. This one is the other direction: a squatter registers a victim's
address first (password, sessions, other provider ids, a two-factor secret — all unproved), then the real owner arrives with a provider that DOES verify the
address and is tied to that account by the e-mail match. Now, in one transaction: the account becomes verified, the password is cleared (a new one only by a
reset mailed to the proved address), every sign-in ends, every other provider identity is untied, the two-factor secret goes. The same when the mailbox owner
clicks the verification link of a provider-made account (no password).

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

PASSWORD = "Squatter!Passw0rd-4725"
NEW_PASSWORD = "Owner!NewPassw0rd-4725"
EMAILS = ("victim@d4725.test", "verified@d4725.test", "linked@d4725.test", "provider-made@d4725.test", "pwverify@d4725.test", "twofactor@d4725.test")
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
    """a squatter's sign-up: password, an unproved address, a live session"""
    r = await c.post("/api/v2/auth/register", json={"email": email, "password": PASSWORD, "display_name": "Squatter", "tos_accepted": True})
    assert r.status_code == 201, r.text
    return r.json().get("data", r.json())


async def _callback(c, monkeypatch, *, provider: str, sub: str, email: str, verified: bool):
    import app.routers.auth as auth_router
    from app.core.security import create_oauth_state_token

    monkeypatch.setattr(auth_router, "_exchange_oauth_code_for_userinfo", AsyncMock(return_value=(sub, email, verified)))
    return await c.post("/api/v2/auth/oauth/callback", json={"provider": provider, "code": "c", "state": create_oauth_state_token(provider), "tos_accepted": True})


async def _user(email: str) -> dict:
    row = (await _rows(
        "SELECT email_verified, hashed_password = '' AS no_password, google_id, apple_id, github_id, totp_enabled, totp_secret IS NOT NULL AS has_totp "
        f"FROM users WHERE email = '{email}'"
    ))[0]
    return dict(zip(("verified", "no_password", "google_id", "apple_id", "github_id", "totp_enabled", "has_totp"), row))


async def _live_sessions(email: str) -> int:
    return (await _rows(
        "SELECT count(*) FROM refresh_tokens r JOIN users u ON u.id = r.user_id "
        f"WHERE u.email = '{email}' AND r.revoked_at IS NULL AND r.expires_at > now()"
    ))[0][0]


@pytest.mark.anyio
async def test_a_squatted_account_is_reclaimed_when_a_verified_provider_arrives(world, monkeypatch):
    email = "victim@d4725.test"
    async with _client() as c:
        squat = await _register(c, email)
        # what the squatter also holds: a second provider identity and a two-factor secret
        await _sql(f"UPDATE users SET apple_id = 'squatter-apple', totp_enabled = true, totp_secret = 'SQUATTERSECRET' WHERE email = '{email}'")
        assert await _live_sessions(email) >= 1

        r = await _callback(c, monkeypatch, provider="google", sub="owner-google-sub", email=email, verified=True)
        assert r.status_code == 200, r.text

        u = await _user(email)
        assert u["verified"] is True                                    # the proved mailbox → verified
        assert u["no_password"] is True                                 # the squatter's password is gone
        assert u["google_id"] == "owner-google-sub"                     # the owner's identity is the one tied
        assert u["apple_id"] is None                                    # … and the squatter's other identity is not
        assert (u["totp_enabled"], u["has_totp"]) == (False, False)     # … nor the squatter's two-factor secret
        # the squatter's sign-in is over: its refresh token no longer refreshes, its password no longer logs in
        old = await c.post("/api/v2/auth/refresh", json={"refresh_token": squat["refresh_token"]})
        assert old.status_code == 401, old.text
        login = await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})
        assert login.status_code == 401, login.text
        # the owner has the session this callback made (and only that one)
        assert await _live_sessions(email) == 1
        assert (await _rows(f"SELECT count(*) FROM login_audit_logs WHERE event_type = 'unverified_account_reclaimed' AND email IS NULL AND user_id = (SELECT id FROM users WHERE email = '{email}')"))[0][0] == 1


@pytest.mark.anyio
async def test_the_owner_is_not_left_at_a_dead_end_a_mailed_reset_gives_a_new_password(world, monkeypatch):
    """AC3: password sign-up (unverified) → Google → in; the password is gone, and a reset (the mailed link) sets a new one"""
    from app.core.security import create_password_reset_token

    email = "victim@d4725.test"
    async with _client() as c:
        await _register(c, email)
        assert (await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)).status_code == 200
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), ""), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        login = await c.post("/api/v2/auth/token", json={"email": email, "password": NEW_PASSWORD})
        assert login.status_code == 200, login.text


@pytest.mark.anyio
async def test_a_mailed_reset_by_the_owner_takes_over_an_unproved_account_squatter_left_nothing_behind(world, monkeypatch):
    """Didi's variant: a provider-made UNVERIFIED account (the squatter holds the provider identity and a two-factor secret); the real owner proves the
    mailbox by a mailed password reset → verified, the new password works, the squatter's provider identity / two-factor secret / sessions are gone"""
    from app.core.security import create_password_reset_token

    email = "provider-made@d4725.test"
    async with _client() as c:
        first = await _callback(c, monkeypatch, provider="google", sub="squatter-sub", email=email, verified=False)
        squat_rt = first.json().get("data", first.json())["refresh_token"]
        await _sql(f"UPDATE users SET totp_enabled = true, totp_secret = 'SQUATTERSECRET' WHERE email = '{email}'")
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), ""), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        u = await _user(email)
        assert (u["verified"], u["no_password"], u["google_id"], u["totp_enabled"], u["has_totp"]) == (True, False, None, False, False)
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": squat_rt})).status_code == 401
        assert (await c.post("/api/v2/auth/token", json={"email": email, "password": NEW_PASSWORD})).status_code == 200


@pytest.mark.anyio
async def test_a_mailed_reset_of_a_verified_account_keeps_its_provider_links_and_two_factor(world, monkeypatch):
    """the normal case: a proved account resets its password — only the sessions end; its Google link and two-factor secret stay"""
    from app.core.security import create_password_reset_token, hash_password

    email = "verified@d4725.test"
    async with _client() as c:
        await _register(c, email)
        h = hash_password(PASSWORD)
        await _sql(f"UPDATE users SET email_verified = true, google_id = 'my-google', totp_enabled = true, totp_secret = 'MINE' WHERE email = '{email}'")
        uid, stored = (await _rows(f"SELECT id, hashed_password FROM users WHERE email = '{email}'"))[0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), stored), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        u = await _user(email)
        assert (u["verified"], u["no_password"], u["google_id"], u["totp_enabled"], u["has_totp"]) == (True, False, "my-google", True, True)


@pytest.mark.anyio
async def test_an_unverified_password_account_reset_by_mail_becomes_verified_with_the_new_password(world, monkeypatch):
    """the owner of a password account that never clicked the verification link resets by mail: the mailbox is proved, the new password works"""
    from app.core.security import create_password_reset_token

    email = "pwverify@d4725.test"
    async with _client() as c:
        mine = await _register(c, email)
        uid, stored = (await _rows(f"SELECT id, hashed_password FROM users WHERE email = '{email}'"))[0]
        reset = await c.post("/api/v2/auth/reset-password", json={"token": create_password_reset_token(str(uid), stored), "new_password": NEW_PASSWORD})
        assert reset.status_code == 200, reset.text
        assert (await _user(email))["verified"] is True
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": mine["refresh_token"]})).status_code == 401
        assert (await c.post("/api/v2/auth/token", json={"email": email, "password": NEW_PASSWORD})).status_code == 200


@pytest.mark.anyio
async def test_the_squatters_old_access_token_is_refused_on_every_route_even_from_the_same_second(world, monkeypatch):
    """codex 01a14749 + Mirko 6227953388: the reclaim ends refresh tokens, but an ACCESS token already issued (60 min) still passed the signature check.
    One per-user cut-off (auth_valid_after, checked on every request) refuses it everywhere — two-factor setup, personal keys, provider linking, plain reads —
    including a token minted in the SAME second as the reclaim (no sleep here). The owner's session made by the reclaiming callback passes."""
    from app.core.security import create_oauth_state_token

    email = "victim@d4725.test"
    async with _client() as c:
        squat = await _register(c, email)                         # the squatter's token: minted this very second
        stale = {"Authorization": f"Bearer {squat['access_token']}"}
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        assert (await c.get("/api/v2/auth/me", headers=stale)).status_code == 200      # before the reclaim it works
        r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
        # not vacuous (codex 01a1478d): the squatter's token is at or before the stored cut-off, the owner's is after it
        from jose import jwt as _jwt
        epoch = (await _rows(f"SELECT extract(epoch FROM auth_valid_after) FROM auth_migrations WHERE user_id = '{uid}'"))[0][0]
        squat_iat = _jwt.get_unverified_claims(squat["access_token"])["iat"]
        owner_iat = _jwt.get_unverified_claims(r.json().get("data", r.json())["access_token"])["iat"]
        assert squat_iat <= float(epoch) < owner_iat, (squat_iat, float(epoch), owner_iat)
        assert (await c.get("/api/v2/auth/me", headers=stale)).status_code == 401      # a plain read
        assert (await c.post("/api/v2/auth/totp/setup", headers=stale)).status_code == 401
        assert (await c.post("/api/v2/me/api-keys", json={"name": "squatter", "expires_at": "2099-01-01T00:00:00Z"}, headers=stale)).status_code == 401
        link = await c.post("/api/v2/auth/oauth/google/link/callback", headers=stale,
                            json={"provider": "google", "code": "c", "state": create_oauth_state_token("google", link_user_id=str(uid))})
        assert link.status_code == 401, link.text
        # the owner's own session (made by the reclaiming callback, after the cut-off) works
        fresh = {"Authorization": f"Bearer {r.json().get('data', r.json())['access_token']}"}
        assert (await c.get("/api/v2/auth/me", headers=fresh)).status_code == 200


@pytest.mark.anyio
async def test_the_one_access_verifier_and_the_websocket_refuse_the_squatters_old_token_after_the_reclaim(world, monkeypatch):
    """Mirko 6228236239: the websocket's own token decode and the onboarding event's used to skip the cut-off; both now go through `verify_access_token`"""
    from fastapi import HTTPException

    from app.core.database import async_session_factory
    from app.dependencies.auth import verify_access_token
    from app.routers.ws_chat import _authenticate

    email = "victim@d4725.test"
    async with _client() as c:
        squat = await _register(c, email)
        r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
    fresh_token = r.json().get("data", r.json())["access_token"]
    async with async_session_factory() as db:
        with pytest.raises(HTTPException) as e:
            await verify_access_token(squat["access_token"], db)
        assert e.value.status_code == 401
        assert (await verify_access_token(fresh_token, db))["sub"]                      # the owner's session passes
        # a refresh token is not an access token — the OWNER's (issued after the cut-off, so only the type check can refuse it)
        with pytest.raises(HTTPException) as e2:
            await verify_access_token(r.json().get("data", r.json())["refresh_token"], db)
        assert e2.value.status_code == 401 and "type" in str(e2.value.detail).lower()
    assert await _authenticate(None, squat["access_token"]) is None                    # the websocket
    # …and not by luck (the squatter has no chat membership): the websocket asks the verifier, and a refusal from it ends the connection
    from unittest.mock import AsyncMock

    import app.routers.ws_chat as ws_mod

    spy = AsyncMock(side_effect=HTTPException(status_code=401, detail="Session revoked"))
    monkeypatch.setattr(ws_mod, "verify_access_token", spy)
    assert await ws_mod._authenticate(None, fresh_token) is None
    spy.assert_awaited_once()


@pytest.mark.anyio
async def test_a_signed_token_whose_subject_is_not_a_uuid_is_a_401_not_an_error(world):
    """Mirko 6228652638: only tokens we sign reach the verifier and ours carry UUIDs, but a bad subject must be refused like any bad token (and the websocket ends it)"""
    from fastapi import HTTPException

    from app.core.database import async_session_factory
    from app.core.security import create_access_token
    from app.dependencies.auth import verify_access_token
    from app.routers.ws_chat import _authenticate

    tok = create_access_token("not-a-uuid", "x@d4725.test", {})
    async with async_session_factory() as db:
        with pytest.raises(HTTPException) as e:
            await verify_access_token(tok, db)
        assert e.value.status_code == 401
    assert await _authenticate(None, tok) is None


@pytest.mark.anyio
async def test_what_the_squatter_made_before_the_proof_is_ended_and_what_others_made_stays(world, monkeypatch):
    """PO decision 2 (2026-10-17): the personal keys, the agents it created with their keys, the project keys it created, the phones it registered and the
    desktop setups it confirmed end in the same transaction; the same kinds of things made by SOMEONE ELSE in the same organization stay."""
    email = "victim@d4725.test"
    async with _client() as c:
        await _register(c, email)
    uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
    other = uuid.uuid4()
    org, proj = uuid.uuid4(), uuid.uuid4()
    hm, agent, om, other_agent = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    setup_mine, setup_theirs = uuid.uuid4(), uuid.uuid4()
    await _sql(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','Sq Co','d4725-{org.hex[:8]}','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{proj}','{org}','P')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES ('{other}','other-{org.hex[:8]}@d4725.test','x','O',true,true,0,false,0)",
        f"INSERT INTO members (id,org_id,type,user_id) VALUES ('{hm}','{org}','human','{uid}'),('{om}','{org}','human','{other}')",
        f"INSERT INTO members (id,org_id,type,owner_member_id,name) VALUES ('{agent}','{org}','agent','{hm}','mine'),('{other_agent}','{org}','agent','{om}','theirs')",
        f"INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash) VALUES ('{uuid.uuid4()}','{agent}','{agent}','k1','h1'),('{uuid.uuid4()}','{other_agent}','{other_agent}','k2','h2')",
        f"INSERT INTO project_api_keys (id,project_id,created_by,name,key_prefix,key_hash) VALUES ('{uuid.uuid4()}','{proj}','{uid}','mine','p1','ph1'),('{uuid.uuid4()}','{proj}','{other}','theirs','p2','ph2')",
        f"INSERT INTO remote_devices (id,member_id,org_id,label,public_key,fingerprint) VALUES ('{uuid.uuid4()}','{hm}','{org}','mine','pk1','fp-{org.hex}-1'),('{uuid.uuid4()}','{om}','{org}','theirs','pk2','fp-{org.hex}-2')",
        f"INSERT INTO auth_identities (id,user_id,issuer,subject) VALUES ('{uuid.uuid4()}','{uid}','https://securetoken.example/p','squatter-fb-sub')",
        f"INSERT INTO desktop_setups (id,code_hash,code_challenge,device_name,expires_at,confirmed_by) VALUES ('{setup_mine}','c1','ch1','mine',now()+interval '1 day','{uid}'),('{setup_theirs}','c2','ch2','theirs',now()+interval '1 day','{other}')",
        f"INSERT INTO desktop_device_tokens (id,setup_id,token_hash) VALUES ('{uuid.uuid4()}','{setup_mine}','dt1-{org.hex}'),('{uuid.uuid4()}','{setup_theirs}','dt2-{org.hex}')",
        f"INSERT INTO human_api_keys (id,member_id,name,key_prefix,key_hash) VALUES ('{uuid.uuid4()}','{hm}','mine','hu1','hh1-{org.hex}'),('{uuid.uuid4()}','{om}','theirs','hu2','hh2-{org.hex}')",
        f"INSERT INTO oauth_handoff_codes (id,user_id,code_hash,purpose,code_challenge,callback_mode,return_uri,created_at,expires_at) VALUES ('{uuid.uuid4()}','{uid}','hc1-{org.hex}','login','x','https','https://x.test/cb',now(),now()+interval '1 minute'),('{uuid.uuid4()}','{other}','hc2-{org.hex}','login','x','https','https://x.test/cb',now(),now()+interval '1 minute')",
    )
    async with _client() as c:
        r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
    live = lambda q: _rows(q)  # noqa: E731
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM agent_api_keys WHERE member_id = '{agent}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM agent_api_keys WHERE member_id = '{other_agent}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM project_api_keys WHERE created_by = '{uid}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM project_api_keys WHERE created_by = '{other}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM remote_devices WHERE member_id = '{hm}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM remote_devices WHERE member_id = '{om}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM desktop_setups WHERE confirmed_by = '{uid}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM desktop_setups WHERE confirmed_by = '{other}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM desktop_device_tokens WHERE setup_id = '{setup_mine}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM desktop_device_tokens WHERE setup_id = '{setup_theirs}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM human_api_keys WHERE member_id = '{hm}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT revoked_at IS NULL FROM human_api_keys WHERE member_id = '{om}'")] == [True]
    assert [r_[0] for r_ in await live(f"SELECT consumed_at IS NULL FROM oauth_handoff_codes WHERE user_id = '{uid}'")] == [False]
    assert [r_[0] for r_ in await live(f"SELECT consumed_at IS NULL FROM oauth_handoff_codes WHERE user_id = '{other}'")] == [True]
    assert (await live(f"SELECT count(*) FROM auth_identities WHERE user_id = '{uid}'"))[0][0] == 0      # the Firebase identity is untied with the others
    # the account's organization membership / its human member row stay
    assert (await live(f"SELECT count(*) FROM members WHERE id = '{hm}'"))[0][0] == 1
    # cleanup of the rows this test made
    await _sql(
        f"DELETE FROM oauth_handoff_codes WHERE user_id IN ('{uid}','{other}')",
        f"DELETE FROM human_api_keys WHERE member_id IN ('{hm}','{om}')",
        f"DELETE FROM desktop_device_tokens WHERE setup_id IN ('{setup_mine}','{setup_theirs}')",
        f"DELETE FROM auth_identities WHERE user_id = '{uid}'",
        f"DELETE FROM desktop_setups WHERE confirmed_by IN ('{uid}','{other}')",
        f"DELETE FROM remote_devices WHERE org_id = '{org}'",
        f"DELETE FROM project_api_keys WHERE project_id = '{proj}'",
        f"DELETE FROM agent_api_keys WHERE member_id IN ('{agent}','{other_agent}')",
        f"DELETE FROM members WHERE org_id = '{org}'",
        f"DELETE FROM projects WHERE id = '{proj}'",
        f"DELETE FROM organizations WHERE id = '{org}'",
        f"DELETE FROM users WHERE id = '{other}'",
    )


@pytest.mark.anyio
async def test_a_second_proof_after_the_first_does_not_erase_it(world, monkeypatch):
    """two proofs overlapping (Mirko): the reclaim is a CONDITIONAL update — the loser sees the account already proved and changes nothing"""
    from sqlalchemy import select

    import app.routers.auth as auth_mod
    from app.core.database import async_session_factory
    from app.models.user import User

    email = "victim@d4725.test"
    async with _client() as c:
        await _register(c, email)
    async with async_session_factory() as s:
        stale_view = (await s.execute(select(User).where(User.email == email))).scalar_one()    # both proofs hold the account as it was: unverified
        async with async_session_factory() as s2:
            same = (await s2.execute(select(User).where(User.email == email))).scalar_one()
            first = await auth_mod._reclaim_unproved_account(s2, same, keep_provider=("google", "winner"), why="test-first")
            await s2.commit()
        assert first is not None
        second = await auth_mod._reclaim_unproved_account(s, stale_view, keep_provider=("apple", "loser"), why="test-second")
        await s.commit()
        assert second is None
    u = await _user(email)
    assert (u["verified"], u["google_id"], u["apple_id"]) == (True, "winner", None)


@pytest.mark.anyio
async def test_an_account_already_proved_keeps_its_password_and_sessions(world, monkeypatch):
    email = "verified@d4725.test"
    async with _client() as c:
        mine = await _register(c, email)
        await _sql(f"UPDATE users SET email_verified = true, apple_id = 'kept-apple' WHERE email = '{email}'")
        r = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
        u = await _user(email)
        assert (u["verified"], u["no_password"], u["google_id"], u["apple_id"]) == (True, False, "owner-sub", "kept-apple")
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": mine["refresh_token"]})).status_code == 200
        assert (await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})).status_code == 200


@pytest.mark.anyio
async def test_an_identity_already_tied_signs_in_unchanged_even_if_the_account_is_unproved(world, monkeypatch):
    """matched by the provider id, not by the e-mail text: nothing is reclaimed (the same person coming back)"""
    email = "linked@d4725.test"
    async with _client() as c:
        mine = await _register(c, email)
        await _sql(f"UPDATE users SET google_id = 'known-sub' WHERE email = '{email}'")
        r = await _callback(c, monkeypatch, provider="google", sub="known-sub", email=email, verified=True)
        assert r.status_code == 200, r.text
        u = await _user(email)
        assert (u["verified"], u["no_password"]) == (False, False)
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": mine["refresh_token"]})).status_code == 200


@pytest.mark.anyio
async def test_a_provider_made_unverified_account_is_reclaimed_by_a_later_verified_provider(world, monkeypatch):
    """(b): an account made through a provider that did not vouch for the address; a later provider that does takes it over cleanly"""
    email = "provider-made@d4725.test"
    async with _client() as c:
        first = await _callback(c, monkeypatch, provider="google", sub="squatter-sub", email=email, verified=False)
        assert first.status_code == 200, first.text
        squat_rt = first.json().get("data", first.json())["refresh_token"]
        assert (await _user(email))["verified"] is False
        second = await _callback(c, monkeypatch, provider="google", sub="owner-sub", email=email, verified=True)
        assert second.status_code == 200, second.text
        u = await _user(email)
        assert (u["verified"], u["google_id"]) == (True, "owner-sub")
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": squat_rt})).status_code == 401


@pytest.mark.anyio
async def test_mail_verification_of_a_provider_made_account_reclaims_it(world, monkeypatch):
    """(b) with the mailbox owner clicking the verification link: no password to drop, but the earlier sessions and provider ids go"""
    from app.core.security import create_email_verification_token

    email = "provider-made@d4725.test"
    async with _client() as c:
        first = await _callback(c, monkeypatch, provider="google", sub="squatter-sub", email=email, verified=False)
        squat_rt = first.json().get("data", first.json())["refresh_token"]
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        r = await c.get("/api/v2/auth/verify-email", params={"token": create_email_verification_token(str(uid))})
        assert r.status_code == 200, r.text
        u = await _user(email)
        assert (u["verified"], u["google_id"]) == (True, None)
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": squat_rt})).status_code == 401


@pytest.mark.anyio
async def test_mail_verification_of_a_password_account_keeps_the_password_and_sessions(world, monkeypatch):
    """the normal flow: the person who registered clicks the link in their own mailbox — nothing is taken from them"""
    from app.core.security import create_email_verification_token

    email = "pwverify@d4725.test"
    async with _client() as c:
        mine = await _register(c, email)
        uid = (await _rows(f"SELECT id FROM users WHERE email = '{email}'"))[0][0]
        r = await c.get("/api/v2/auth/verify-email", params={"token": create_email_verification_token(str(uid))})
        assert r.status_code == 200, r.text
        u = await _user(email)
        assert (u["verified"], u["no_password"]) == (True, False)
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": mine["refresh_token"]})).status_code == 200
        assert (await c.post("/api/v2/auth/token", json={"email": email, "password": PASSWORD})).status_code == 200


@pytest.mark.anyio
async def test_an_unverified_provider_claim_reclaims_nothing(world, monkeypatch):
    """4724 still refuses first: no reclaim, nothing changes for the existing account"""
    email = "twofactor@d4725.test"
    async with _client() as c:
        mine = await _register(c, email)
        await _sql(f"UPDATE users SET totp_enabled = true, totp_secret = 'S' WHERE email = '{email}'")
        r = await _callback(c, monkeypatch, provider="google", sub="attacker-sub", email=email, verified=False)
        assert r.status_code == 403, r.text
        u = await _user(email)
        assert (u["verified"], u["no_password"], u["google_id"], u["totp_enabled"]) == (False, False, None, True)
        assert (await c.post("/api/v2/auth/refresh", json={"refresh_token": mine["refresh_token"]})).status_code == 200
