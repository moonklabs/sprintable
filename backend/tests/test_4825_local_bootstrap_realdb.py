"""story #4825 (공개 2-② (나)) — `POST /api/v2/auth/local-bootstrap` over real HTTP on a migrated PG (ALEMBIC_DATABASE_URL · DATABASE_URL).

The embedded server gives its owner a session with no sign-up and no e-mail verification. Each test goes red without the line it names:
AC1 the first call makes ONE owner (verified, no password), ONE organization and ONE project, and the session works (`/auth/me`, `/organizations`, `/projects`)
    · a second and a third call find the same owner and make nothing new (the app calls it on every launch) · two calls at once make one set
AC4 hosted behaviour: with the switch off the route is not registered (404) · a wrong or missing secret · a caller that is not loopback · a
    secret of the wrong length → the same bare 403 and nothing written · the owner cannot sign in with a password · register/login are unchanged
The secret value is never in a response body or a log line.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]

# imported here, at collection time, so main.py's import-time route registration sees a clean environment (no embedded switch) — a later import
# inside a test that has the switch monkeypatched on would register the route on the real app for the rest of the process
from app.main import app as real_app  # noqa: E402

OWNER_EMAIL = "owner@local.sprintable"
SECRET = "t4825-" + secrets.token_hex(24)  # 54 chars, fresh per run
URL = "/api/v2/auth/local-bootstrap"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _sql(*stmts: str, params: dict | None = None, fetch: str | None = None):
    eng = create_async_engine(_ASYNC, poolclass=NullPool)
    try:
        async with async_sessionmaker(eng)() as s:
            out = None
            for st in stmts:
                r = await s.execute(text(st), params or {})
                if fetch == "all":
                    out = r.all()
                elif fetch == "one":
                    out = r.first()
            await s.commit()
            return out
    finally:
        await eng.dispose()


async def _wipe_owner() -> None:
    """remove everything the owner (and only the owner) made — other tests' rows are left alone"""
    await _sql(
        f"""DELETE FROM project_access WHERE project_id IN (SELECT p.id FROM projects p JOIN org_members om ON om.org_id = p.org_id
              JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')""",
        f"DELETE FROM projects WHERE org_id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')",
        f"DELETE FROM members WHERE user_id IN (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')",
        f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')",
        f"DELETE FROM login_audit_logs WHERE email = '{OWNER_EMAIL}'",
        f"""DELETE FROM organizations WHERE id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')""",
        f"DELETE FROM org_members WHERE user_id IN (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')",
        f"DELETE FROM users WHERE email = '{OWNER_EMAIL}'",
    )


@pytest.fixture
async def embedded(monkeypatch):
    """a fresh app that carries the route ONLY because the embedded switch is on — exactly how main.py registers it"""
    from fastapi import FastAPI
    from slowapi.errors import RateLimitExceeded  # noqa: F401

    from app.core.config import settings
    from app.core.rate_limit import limiter
    from app.routers import local_auth

    monkeypatch.setenv("SPRINTABLE_EMBEDDED", "1")
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    monkeypatch.delenv("K_SERVICE", raising=False)
    limiter.reset()
    local_auth._failures.clear()
    local_auth._suppressed = 0
    await _wipe_owner()
    app = FastAPI()
    app.state.limiter = limiter
    from fastapi.exceptions import RequestValidationError

    from app.main import validation_exception_handler

    app.add_exception_handler(RequestValidationError, validation_exception_handler)  # the real app's 422 answer (what a refusal may carry)
    assert local_auth.register_local_auth_routes(app) is True
    yield app
    await _wipe_owner()


def _client(app, host: str = "127.0.0.1"):
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False, client=(host, 50000)), base_url="http://127.0.0.1")


def _h(secret: str | None = SECRET) -> dict:
    return {} if secret is None else {"X-Local-Bootstrap-Secret": secret}


async def _counts() -> tuple[int, int, int, int]:
    r = await _sql(
        f"""SELECT (SELECT count(*) FROM users WHERE email = '{OWNER_EMAIL}'),
                   (SELECT count(*) FROM organizations o WHERE o.id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')),
                   (SELECT count(*) FROM projects p WHERE p.org_id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')),
                   (SELECT count(*) FROM org_members om JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}')""",
        fetch="one",
    )
    return tuple(int(x) for x in r)


async def test_01_the_first_call_makes_one_owner_one_org_one_project_and_a_working_session(embedded):
    async with _client(embedded) as c:
        r = await c.post(URL, headers=_h(), json={"display_name": "Yoon", "org_name": "My Lab", "project_name": "First"})
    assert r.status_code == 200, r.text
    tokens = r.json()["data"]
    assert tokens["access_token"] and tokens["refresh_token"]
    assert SECRET not in r.text
    assert await _counts() == (1, 1, 1, 1)
    row = await _sql(
        f"SELECT email_verified, hashed_password, display_name, is_active FROM users WHERE email = '{OWNER_EMAIL}'", fetch="one",
    )
    assert row.email_verified is True and row.hashed_password == "" and row.display_name == "Yoon" and row.is_active is True
    # the session is a real one: the real app accepts the access token and sees the organization and the project
    from httpx import ASGITransport, AsyncClient

    hdr = {"Authorization": f"Bearer {tokens['access_token']}"}
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        me = await rc.get("/api/v2/auth/me", headers=hdr)
        orgs = await rc.get("/api/v2/organizations", headers=hdr)
    me_body = me.json().get("data", me.json())  # /auth/me answers with or without the {data} envelope
    assert me.status_code == 200 and me_body["email"] == OWNER_EMAIL and me_body["email_verified"] is True, me.text
    assert [o["name"] for o in orgs.json()] == ["My Lab"] and orgs.json()[0]["role"] == "owner", orgs.text
    claims_org = me_body.get("org_id") or (me_body.get("app_metadata") or {}).get("org_id")
    assert claims_org == orgs.json()[0]["id"], me.text


async def test_02_later_calls_find_the_same_owner_and_make_nothing_new(embedded):
    async with _client(embedded) as c:
        first = (await c.post(URL, headers=_h(), json={"org_name": "Lab"})).json()["data"]
        second = await c.post(URL, headers=_h(), json={"org_name": "Another name that must not create a second org"})
        third = await c.post(URL, headers=_h())
    assert second.status_code == 200 and third.status_code == 200
    assert await _counts() == (1, 1, 1, 1)  # still one owner · one org · one project · one membership
    names = await _sql(
        f"SELECT o.name FROM organizations o JOIN org_members om ON om.org_id = o.id JOIN users u ON u.id = om.user_id WHERE u.email = '{OWNER_EMAIL}'",
        fetch="all",
    )
    assert [n.name for n in names] == ["Lab"]
    # every call is its own session (a new refresh token each time), none of them replaces the owner
    toks = {first["refresh_token"], second.json()["data"]["refresh_token"], third.json()["data"]["refresh_token"]}
    assert len(toks) == 3
    n = (await _sql(f"SELECT count(*) FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')", fetch="one"))[0]
    assert n == 3


async def test_03_two_calls_at_the_same_moment_still_make_one_set(embedded):
    async with _client(embedded) as c1, _client(embedded) as c2:
        a, b = await asyncio.gather(c1.post(URL, headers=_h(), json={}), c2.post(URL, headers=_h(), json={}))
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    assert await _counts() == (1, 1, 1, 1)


async def test_04_every_refusal_is_the_same_bare_403_and_writes_nothing(embedded, caplog):
    caplog.set_level(logging.DEBUG)
    bodies = []
    async with _client(embedded) as c:
        for hdr in (_h(None), _h(""), _h("wrong-" + SECRET), _h(SECRET[:-1]), _h(SECRET + "x")):
            r = await c.post(URL, headers=hdr)
            assert r.status_code == 403, (hdr, r.text)
            bodies.append(r.json())
    async with _client(embedded, host="10.1.2.3") as far:  # the right secret, but not from this machine
        r = await far.post(URL, headers=_h())
        assert r.status_code == 403
        bodies.append(r.json())
    async with _client(embedded, host="::1") as v6:  # loopback in IPv6 is fine
        ok = await v6.post(URL, headers=_h())
        assert ok.status_code == 200
    assert all(b == bodies[0] for b in bodies)  # the refusal never says which check failed
    assert await _counts() == (1, 1, 1, 1)  # only the ::1 call wrote anything
    assert SECRET not in caplog.text and SECRET not in ok.text


async def test_05_nothing_is_written_when_the_secret_is_wrong(embedded):
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h("nope"))).status_code == 403
    assert await _counts() == (0, 0, 0, 0)


async def test_06_the_owner_has_no_password_and_cannot_sign_in_with_one(embedded):
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        for pw in ("", "password", SECRET):
            r = await rc.post("/api/v2/auth/token", json={"email": OWNER_EMAIL, "password": pw or "x"})
            assert r.status_code in (400, 401, 422, 429), (pw, r.status_code, r.text)
            assert not (r.json().get("data") or {}).get("access_token")


async def test_07_with_the_switch_off_the_route_does_not_exist(monkeypatch):
    from fastapi import FastAPI

    from app.core.config import settings
    from app.routers import local_auth

    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)  # a secret without the switch registers nothing
    app = FastAPI()
    assert local_auth.register_local_auth_routes(app) is False
    async with _client(app) as c:
        r = await c.post(URL, headers=_h())
    assert r.status_code == 404
    assert await _counts() == (0, 0, 0, 0)


async def test_07b_a_miswired_mount_with_the_switch_off_still_refuses(monkeypatch):
    """the route exists on this app only by a wrong wiring (included directly, not through register_local_auth_routes): the handler's own
    check must still refuse — right secret, from loopback, nothing is created"""
    from fastapi import FastAPI

    from app.core.config import settings
    from app.core.rate_limit import limiter
    from app.routers import local_auth

    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    limiter.reset()
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(local_auth.router)
    async with _client(app) as c:
        r = await c.post(URL, headers=_h())
    assert r.status_code == 403, r.text
    assert await _counts() == (0, 0, 0, 0)


async def test_10_a_deactivated_or_deleted_owner_gets_a_controlled_refusal_not_a_session_or_a_500(embedded):
    """the owner row deactivated or purged: the same bare 403, nothing written, no session (never a unique-key 500 from a second insert)"""
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200
        base = await _counts()
        n_tokens = (await _sql(f"SELECT count(*) FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')", fetch="one"))[0]
        for bad in (
            "is_active = false",
            "is_active = false, deleted_at = now()",
        ):
            await _sql(f"UPDATE users SET {bad} WHERE email = '{OWNER_EMAIL}'")
            r = await c.post(URL, headers=_h())
            assert r.status_code == 403, (bad, r.status_code, r.text)
            assert not (r.json().get("data") or {}).get("access_token")
            assert await _counts() == base
            assert (await _sql(f"SELECT count(*) FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')", fetch="one"))[0] == n_tokens
            await _sql(f"UPDATE users SET hashed_password = '', totp_enabled = false, is_active = true, deleted_at = NULL WHERE email = '{OWNER_EMAIL}'")
        assert (await c.post(URL, headers=_h())).status_code == 200  # restored, and it is the owner again


async def test_10b_setting_a_password_or_a_second_factor_later_never_locks_the_owner_out(embedded):
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200
        for change in ("hashed_password = '$2b$12$setlaterbytheowner'", "totp_enabled = true"):
            await _sql(f"UPDATE users SET {change} WHERE email = '{OWNER_EMAIL}'")
            r = await c.post(URL, headers=_h())
            assert r.status_code == 200 and r.json()["data"]["access_token"], (change, r.text)
    assert await _counts() == (1, 1, 1, 1)


async def test_10c_register_refuses_the_reserved_owner_address_only_on_an_embedded_install(embedded, monkeypatch):
    """the owner's account can be made by local-bootstrap alone on an embedded install; on a hosted one sign-up is exactly as before"""
    from httpx import ASGITransport, AsyncClient

    body = {"email": OWNER_EMAIL, "password": "Aa1!aaaaaaaaaa", "display_name": "Squatter", "tos_accepted": True}
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        refused = await rc.post("/api/v2/auth/register", json=body)  # `embedded` fixture: the switch is on
        assert refused.status_code == 409, refused.text
        assert (await _counts())[0] == 0
        monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)  # hosted: no switch
        try:
            made = await rc.post("/api/v2/auth/register", json=body)
            assert made.status_code == 201, made.text
        finally:
            await _wipe_owner()


async def test_15_a_deleted_first_project_is_not_made_again_on_the_next_launch(embedded):
    """the project belongs to the organization the first call made; a person who deletes their projects does not get one back (nor a slug collision
    with the deleted row — an error) on every launch"""
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h(), json={"project_name": "Mine"})).status_code == 200
        await _sql(
            f"""UPDATE projects SET deleted_at = now() WHERE org_id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id
                  WHERE u.email = '{OWNER_EMAIL}')"""
        )
        for _ in range(2):
            r = await c.post(URL, headers=_h(), json={"project_name": "Mine"})
            assert r.status_code == 200 and r.json()["data"]["access_token"], r.text
    total = await _sql(
        f"""SELECT count(*) FROM projects p WHERE p.org_id IN (SELECT om.org_id FROM org_members om JOIN users u ON u.id = om.user_id
              WHERE u.email = '{OWNER_EMAIL}')""",
        fetch="one",
    )
    assert total[0] == 1  # the deleted one, and nothing new


async def test_17_the_session_is_for_the_owned_organization_not_another_one_the_owner_belongs_to(embedded):
    """the account is also a plain member of an older organization that is its `last_org_id`: the session must still be for the install's own"""
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200  # makes the owner and its organization
        uid = (await _sql(f"SELECT id FROM users WHERE email = '{OWNER_EMAIL}'", fetch="one"))[0]
        own = (await _sql(f"SELECT org_id FROM org_members WHERE user_id = '{uid}' AND role = 'owner'", fetch="one"))[0]
        other = uuid.uuid4()
        try:
            await _sql(
                f"INSERT INTO organizations (id, name, slug) VALUES ('{other}', 'Elsewhere', 't4825-{other.hex[:10]}')",
                f"INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), '{other}', '{uid}', 'member', now() - interval '3 days')",
                f"UPDATE users SET last_org_id = '{other}' WHERE id = '{uid}'",
            )
            from app.core.security import decode_jwt

            tokens = (await c.post(URL, headers=_h())).json()["data"]
            claims = decode_jwt(tokens["access_token"])
            assert str((claims.get("app_metadata") or {}).get("org_id")) == str(own), claims
        finally:
            await _sql(
                f"UPDATE users SET last_org_id = NULL WHERE id = '{uid}'",
                f"DELETE FROM org_members WHERE org_id = '{other}'",
                f"DELETE FROM organizations WHERE id = '{other}'",
            )


async def test_18_wrong_secrets_are_throttled_but_the_right_one_always_passes(embedded):
    """a program on this machine that keeps failing must not lock the app out of its own server: only WRONG secrets count toward the limit"""
    async with _client(embedded) as c:
        codes = [(await c.post(URL, headers=_h(f"wrong-{i}"))).status_code for i in range(40)]
        assert codes[:30] == [403] * 30 and set(codes[30:]) == {429}, codes
        throttled = await c.post(URL, headers=_h("wrong-again"))
        assert throttled.status_code == 429 and throttled.headers.get("retry-after")
        ok = await c.post(URL, headers=_h())
        assert ok.status_code == 200 and ok.json()["data"]["access_token"], ok.text
        assert (await c.post(URL, headers=_h())).status_code == 200
    assert await _counts() == (1, 1, 1, 1)


async def test_18b_after_the_limit_the_throttled_attempts_are_counted_not_logged_one_by_one(embedded, caplog, monkeypatch):
    """a loop of wrong secrets must not push the other lines out of the server's rotating log: ≤ 30 refusal lines + 1 limit line, then ONE count line"""
    import logging

    from app.routers import local_auth

    caplog.set_level(logging.DEBUG, logger="app.routers.local_auth")
    async with _client(embedded) as c:
        for i in range(200):
            await c.post(URL, headers=_h(f"wrong-{i}"))
        lines = [r.getMessage() for r in caplog.records if r.name == "app.routers.local_auth"]
        assert len(lines) == 31, (len(lines), lines[-3:])  # 30 refusals + the one «limit reached» line
        assert sum("limit is reached" in m for m in lines) == 1
        # the window clears: the next call (here a right one) reports the count once
        real = local_auth.time.monotonic
        monkeypatch.setattr(local_auth.time, "monotonic", lambda: real() + 3600)
        assert (await c.post(URL, headers=_h())).status_code == 200
    counted = [r.getMessage() for r in caplog.records if r.name == "app.routers.local_auth" and "were throttled" in r.getMessage()]
    assert len(counted) == 1 and "170" in counted[0], counted
    assert SECRET not in caplog.text


async def test_19_an_embedded_install_serves_only_the_loopback_host_name(monkeypatch):
    """a page that rebinds its own DNS name to 127.0.0.1 arrives with `Host: its-name`: refused on every route; hosted gets no such guard"""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.core.config import settings
    from app.routers import local_auth

    async def _status(app, base_url: str) -> int:
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False, client=("127.0.0.1", 50000)), base_url=base_url) as c:
            return (await c.get("/anything")).status_code

    monkeypatch.setenv("SPRINTABLE_EMBEDDED", "1")
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    monkeypatch.delenv("K_SERVICE", raising=False)
    embedded_app = FastAPI()
    assert local_auth.apply_embedded_host_guard(embedded_app) is True
    assert await _status(embedded_app, "http://evil.example") == 400
    assert await _status(embedded_app, "http://evil.example:8000") == 400
    assert await _status(embedded_app, "http://127.0.0.1:8123") == 404  # served (no such route) — the guard let it through
    assert await _status(embedded_app, "http://127.0.0.1") == 404

    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)  # hosted
    hosted_app = FastAPI()
    assert local_auth.apply_embedded_host_guard(hosted_app) is False
    assert await _status(hosted_app, "http://api.example.com") == 404


async def test_16_a_membership_whose_organization_is_gone_is_not_my_organization(embedded):
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200
        await _sql(f"UPDATE org_members SET org_id = gen_random_uuid() WHERE user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')")
        r = await c.post(URL, headers=_h())
    assert r.status_code == 200, r.text
    live = await _sql(
        f"""SELECT count(*) FROM org_members om JOIN organizations o ON o.id = om.org_id
              WHERE om.role = 'owner' AND om.user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')""",
        fetch="one",
    )
    assert live[0] == 1


async def test_11_a_call_that_came_through_a_proxy_is_refused(embedded):
    async with _client(embedded) as c:
        for hdr in ({"X-Forwarded-For": "203.0.113.9"}, {"Forwarded": "for=203.0.113.9"}, {"X-Real-IP": "203.0.113.9"}):
            r = await c.post(URL, headers={**_h(), **hdr})
            assert r.status_code == 403, (hdr, r.text)
        assert await _counts() == (0, 0, 0, 0)
        assert (await c.post(URL, headers=_h())).status_code == 200


async def test_12_the_session_carries_the_claims_a_password_sign_in_would(embedded):
    from app.core.security import decode_jwt

    async with _client(embedded) as c:
        tokens = (await c.post(URL, headers=_h())).json()["data"]
    uid = (await _sql(f"SELECT id FROM users WHERE email = '{OWNER_EMAIL}'", fetch="one"))[0]
    org_id = (await _sql(f"SELECT org_id FROM org_members WHERE user_id = '{uid}'", fetch="one"))[0]
    acc, ref = decode_jwt(tokens["access_token"]), decode_jwt(tokens["refresh_token"])
    assert acc["sub"] == str(uid) and ref["sub"] == str(uid) and acc["email"] == OWNER_EMAIL
    assert isinstance(acc["session_started_at"], int) and acc["session_started_at"] == ref["session_started_at"]
    assert str((acc.get("app_metadata") or {}).get("org_id")) == str(org_id), acc
    row = await _sql(f"SELECT token_hash, org_id, family_id FROM refresh_tokens WHERE user_id = '{uid}'", fetch="one")
    assert row.token_hash and row.token_hash != tokens["refresh_token"]  # stored hashed, never raw
    assert str(row.org_id) == str(org_id) and row.family_id is not None
    audit = (await _sql(f"SELECT detail FROM login_audit_logs WHERE email = '{OWNER_EMAIL}'", fetch="all"))
    assert [a.detail for a in audit] == ["local_bootstrap"]


async def test_13_the_first_project_is_reachable_through_the_projects_api(embedded):
    async with _client(embedded) as c:
        tokens = (await c.post(URL, headers=_h(), json={"project_name": "Reach me"})).json()["data"]
    from httpx import ASGITransport, AsyncClient

    hdr = {"Authorization": f"Bearer {tokens['access_token']}"}
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        r = await rc.get("/api/v2/projects", headers=hdr)
    assert r.status_code == 200, r.text
    assert "Reach me" in r.text


async def test_14_only_an_organization_the_account_owns_counts_as_its_own(embedded):
    """the account is a plain member of some organization and owns none: it gets an organization of its own instead of borrowing that one"""
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200
        await _sql(f"UPDATE org_members SET role = 'member' WHERE user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')")
        assert (await c.post(URL, headers=_h())).status_code == 200
    owned = await _sql(
        f"SELECT count(*) FROM org_members WHERE role = 'owner' AND user_id = (SELECT id FROM users WHERE email = '{OWNER_EMAIL}')", fetch="one",
    )
    assert owned[0] == 1


SET_URL = "/api/v2/auth/local-set-password"
GOOD_PW = "Aa1!local-owner-pw"


async def _owner_session(c) -> dict:
    return (await c.post(URL, headers=_h())).json()["data"]


def _bearer(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _owner_row():
    return await _sql(f"SELECT id, hashed_password, password_set_at FROM users WHERE email = '{OWNER_EMAIL}'", fetch="one")


async def test_20_the_owner_sets_the_first_password_with_no_mail_and_every_session_ends(embedded, caplog, monkeypatch):
    """story 4825 AC6 — a signed-in owner chooses a password on the spot: no token, no link, no e-mail; all sessions end; the password then works"""
    import logging

    from httpx import ASGITransport, AsyncClient

    import app.services.email as email_service

    def _no_mail(*a, **k):
        raise AssertionError("no e-mail may be sent on this path")

    monkeypatch.setattr(email_service, "send_email", _no_mail)
    caplog.set_level(logging.DEBUG)
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
        r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
    assert r.status_code == 200, r.text
    row = await _owner_row()
    assert row.hashed_password and row.hashed_password != GOOD_PW and row.password_set_at is not None
    live = (await _sql(f"SELECT count(*) FROM refresh_tokens WHERE user_id = '{row.id}' AND revoked_at IS NULL", fetch="one"))[0]
    assert live == 0  # every session of the person ended
    audit = await _sql(f"SELECT detail FROM login_audit_logs WHERE email = '{OWNER_EMAIL}' AND event_type = 'password_set'", fetch="all")
    assert [a.detail for a in audit] == ["local_set_password"]
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        login = await rc.post("/api/v2/auth/token", json={"email": OWNER_EMAIL, "password": GOOD_PW})
        assert login.status_code == 200 and login.json()["data"]["access_token"], login.text
        # the session cannot be renewed: its refresh token is dead (the access token itself is stateless and runs out on its own, as after a change-password)
        renew = await rc.post("/api/v2/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
        assert renew.status_code == 401, renew.text
    assert GOOD_PW not in caplog.text and row.hashed_password not in caplog.text and SECRET not in caplog.text
    assert "token=" not in caplog.text


async def test_21_every_other_state_is_refused_and_the_password_stays_unset(embedded, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    import app.routers.auth as auth_router
    from app.core.rate_limit import limiter

    other = f"t4825-other-{uuid.uuid4().hex[:8]}@example.com"
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
        uid = (await _owner_row()).id
        # no session / a bad token
        assert (await c.post(SET_URL, json={"new_password": GOOD_PW})).status_code == 401
        assert (await c.post(SET_URL, headers={"Authorization": "Bearer nope"}, json={"new_password": GOOD_PW})).status_code == 401
        # the password rules of the mailed flow
        for weak in ("sh1A!", "alllowercaseletters", "NOLOWERCASE12345"):
            assert (await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": weak})).status_code == 422, weak
        # an API-key session: a token whose claims carry an agent key / a person's personal key id (what the mailed flow's predicate reads)
        from app.core.security import create_tokens, decode_jwt

        claims = decode_jwt(tokens["access_token"])
        for key_claim in ("api_key_id", "human_api_key_id"):
            keyed = create_tokens(str(uid), email=OWNER_EMAIL, app_metadata={**claims.get("app_metadata", {}), key_claim: str(uuid.uuid4())})
            r = await c.post(SET_URL, headers=_bearer(keyed), json={"new_password": GOOD_PW})
            assert r.status_code == 403 and r.json()["error"]["code"] == "REQUIRES_INTERACTIVE_SESSION", (key_claim, r.text)
        # a second factor on the account
        await _sql(f"UPDATE users SET totp_enabled = true WHERE id = '{uid}'")
        r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
        assert r.status_code == 409 and r.json()["error"]["code"] == "TOTP_ENABLED", r.text
        await _sql(f"UPDATE users SET totp_enabled = false WHERE id = '{uid}'")
        # the account already has a password
        await _sql(f"UPDATE users SET hashed_password = '$2b$12$alreadyset' WHERE id = '{uid}'")
        r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
        assert r.status_code == 400 and r.json()["error"]["code"] == "ALREADY_HAS_PASSWORD", r.text
        await _sql(f"UPDATE users SET hashed_password = '' WHERE id = '{uid}'")
        # someone who is not the owner (a plain sign-up on this install)
        try:
            async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
                limiter.reset()
                reg = await rc.post("/api/v2/auth/register", json={"email": other, "password": "Aa1!aaaaaaaaaa", "display_name": "Other", "tos_accepted": True})
                assert reg.status_code == 201, reg.text
                login = await rc.post("/api/v2/auth/token", json={"email": other, "password": "Aa1!aaaaaaaaaa"})
                theirs = login.json()["data"]
            r = await c.post(SET_URL, headers=_bearer(theirs), json={"new_password": GOOD_PW})
            assert r.status_code == 403 and r.json()["error"]["code"] == "NOT_LOCAL_OWNER", r.text
        finally:
            await _sql(
                f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '{other}')",
                f"DELETE FROM login_audit_logs WHERE email = '{other}'",
                f"DELETE FROM users WHERE email = '{other}'",
            )
    assert (await _owner_row()).hashed_password == ""  # nothing above wrote a password


async def test_21b_a_password_that_lands_between_the_look_and_the_write_is_not_overwritten(embedded, monkeypatch):
    """the early look found no password; another call writes one before this one does (made deterministic: it lands as this call takes the person's session lock).
    The write itself is conditional on there still being none, so this call is refused and the other password stays"""
    import app.routers.auth as auth_router

    other_hash = "$2b$12$writtenbyanothercall"
    original = auth_router._lock_person_sessions

    async def _lock_after_a_rival_write(session, user_id, **kw):
        await _sql(f"UPDATE users SET hashed_password = '{other_hash}' WHERE email = '{OWNER_EMAIL}'")
        return await original(session, user_id, **kw)

    async with _client(embedded) as c:
        tokens = await _owner_session(c)
        monkeypatch.setattr(auth_router, "_lock_person_sessions", _lock_after_a_rival_write)
        r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
    assert r.status_code == 400 and r.json()["error"]["code"] == "ALREADY_HAS_PASSWORD", r.text
    assert (await _owner_row()).hashed_password == other_hash  # the rival's password stands, nothing of this call was written


async def test_21c_a_refusal_never_sends_the_chosen_password_back(embedded):
    """FastAPI's default 422 carries each error's `input` (for a body-level error, the WHOLE body): the password a person typed must not come back in the answer"""
    typed = "sh1A!"
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
        weak = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": typed})
        body_level = await c.post(SET_URL, headers={**_bearer(tokens), "Content-Type": "application/json"}, content=json.dumps([typed]))
        wrong_type = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": 123456789})
    for r in (weak, body_level, wrong_type):
        assert r.status_code == 422, r.text
        assert typed not in r.text and "123456789" not in r.text and '"input"' not in r.text, r.text


async def test_21d_a_password_rule_that_stops_holding_between_the_look_and_the_write_is_not_overwritten(embedded, monkeypatch):
    """a second factor turned on, or the account deactivated, while this call waits for the person's session lock: the write holds those conditions too"""
    import app.routers.auth as auth_router

    original = auth_router._lock_person_sessions
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
        for change, status, code in (
            ("totp_enabled = true", 409, "TOTP_ENABLED"),
            ("is_active = false", 403, "FORBIDDEN"),
        ):
            async def _lock_after_a_change(session, user_id, _change=change, **kw):
                await _sql(f"UPDATE users SET {_change} WHERE email = '{OWNER_EMAIL}'")
                return await original(session, user_id, **kw)

            with monkeypatch.context() as m:
                m.setattr(auth_router, "_lock_person_sessions", _lock_after_a_change)
                r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
            assert r.status_code == status and r.json()["error"]["code"] == code, (change, r.text)
            assert (await _owner_row()).hashed_password == "", change
            await _sql(f"UPDATE users SET totp_enabled = false, is_active = true WHERE email = '{OWNER_EMAIL}'")


async def test_21e_bootstrap_takes_the_persons_session_lock_before_it_stores_a_session(embedded, monkeypatch):
    """a bootstrap in flight while local-set-password ends every session must not store a live refresh token behind that revoke: like a password sign-in it
    takes the person's session lock (shared) before the session is stored, so the revoke (exclusive) either ran before it or waits for it"""
    import app.routers.auth as auth_router

    events: list[str] = []
    real_lock, real_store = auth_router._lock_person_sessions, auth_router._store_refresh_token

    async def _lock(session, user_id, *, exclusive):
        events.append(f"lock exclusive={exclusive}")
        return await real_lock(session, user_id, exclusive=exclusive)

    async def _store(*a, **k):
        events.append("store")
        return await real_store(*a, **k)

    monkeypatch.setattr(auth_router, "_lock_person_sessions", _lock)
    monkeypatch.setattr(auth_router, "_store_refresh_token", _store)
    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200  # creates the owner
        events.clear()
        assert (await c.post(URL, headers=_h())).status_code == 200  # the next launch
    assert events == ["lock exclusive=False", "store"], events


async def test_21f_bootstrap_waits_for_a_revoke_in_flight_but_not_for_a_sign_in(embedded):
    """the session lock is real, not just called: while another transaction holds the person's lock EXCLUSIVELY (a password set / change in the middle of ending every
    session) a bootstrap does not store a session; while it is held SHARED (another issuer) a bootstrap goes through"""
    from app.routers.auth import _SESSION_LOCK_NAMESPACE

    async def _waiting_for_an_advisory_lock() -> int:
        return (await _sql("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted", fetch="one"))[0]

    async with _client(embedded) as c:
        assert (await c.post(URL, headers=_h())).status_code == 200  # creates the owner
        uid = str((await _owner_row()).id)
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            for mode, must_wait in (("pg_advisory_xact_lock", True), ("pg_advisory_xact_lock_shared", False)):
                async with async_sessionmaker(eng)() as holder:
                    await holder.execute(text(f"SELECT {mode}(:ns, hashtext(:u))"), {"ns": _SESSION_LOCK_NAMESPACE, "u": uid})
                    task = asyncio.create_task(c.post(URL, headers=_h()))
                    for _ in range(3000):  # a bounded number of looks, not a time budget
                        if task.done() or await _waiting_for_an_advisory_lock():
                            break
                        await asyncio.sleep(0.01)
                    assert (not task.done()) is must_wait, mode
                    await holder.commit()
                assert (await task).status_code == 200, mode
        finally:
            await eng.dispose()


async def test_21g_on_an_embedded_install_no_auth_refusal_sends_back_what_was_typed_a_hosted_one_is_as_before(embedded, monkeypatch):
    """a password in the body of any /api/v2/auth/ call that is refused as malformed is not echoed on an embedded install (the mailed-request route and the
    sign-in are reachable directly); with the switch off the answer is exactly the framework default, `input` included"""
    from httpx import ASGITransport, AsyncClient

    typed = "sh1A!"
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
    calls = (
        ("/api/v2/auth/set-password/request", {"new_password": typed}, _bearer(tokens)),
        ("/api/v2/auth/token", {"email": OWNER_EMAIL, "password": 123456789}, {}),
    )

    async def _answers() -> list[str]:
        out = []
        async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
            for path, payload, hdr in calls:
                r = await rc.post(path, headers=hdr, json=payload)
                assert r.status_code == 422, (path, r.text)
                out.append(r.text)
        return out

    for text_ in await _answers():
        assert typed not in text_ and "123456789" not in text_ and '"input"' not in text_, text_
    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)  # a hosted process: the default answer, unchanged
    hosted = await _answers()
    assert all('"input"' in text_ for text_ in hosted), hosted


async def test_22_the_route_exists_only_on_an_embedded_install(monkeypatch):
    from fastapi import FastAPI

    from app.core.config import settings
    from app.routers import local_auth

    assert SET_URL not in {getattr(r, "path", None) for r in real_app.routes}  # not on the hosted app this process builds
    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    app = FastAPI()
    assert local_auth.register_local_auth_routes(app) is False
    async with _client(app) as c:
        assert (await c.post(SET_URL, json={"new_password": GOOD_PW})).status_code == 404


async def test_22b_a_miswired_mount_with_the_switch_off_still_refuses_to_set_a_password(embedded, monkeypatch):
    """the route sits on an app only by a wrong wiring (included directly): the handler's own check refuses even a valid owner session, and no password is written"""
    from fastapi import FastAPI

    from app.core.rate_limit import limiter
    from app.routers import local_auth

    async with _client(embedded) as c:
        tokens = await _owner_session(c)
    monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)
    bare = FastAPI()
    bare.state.limiter = limiter
    bare.include_router(local_auth.router)
    async with _client(bare) as c:
        r = await c.post(SET_URL, headers=_bearer(tokens), json={"new_password": GOOD_PW})
    assert r.status_code == 403, r.text
    assert (await _owner_row()).hashed_password == ""


async def test_23_on_an_embedded_install_the_mailed_request_is_closed_before_any_token_exists(embedded, caplog, monkeypatch):
    import logging

    from httpx import ASGITransport, AsyncClient

    import app.routers.auth as auth_router
    import app.services.email as email_service

    def _no_mail(*a, **k):
        raise AssertionError("no e-mail may be sent")

    monkeypatch.setattr(email_service, "send_email", _no_mail)
    monkeypatch.setattr(auth_router, "create_set_password_confirm_token", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no token may be made")))
    monkeypatch.setattr(auth_router.resend_verification_limiter, "enabled", False)
    caplog.set_level(logging.DEBUG)
    async with _client(embedded) as c:
        tokens = await _owner_session(c)
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
        r = await rc.post("/api/v2/auth/set-password/request", headers=_bearer(tokens), json={"new_password": GOOD_PW})
    assert r.status_code == 409 and r.json()["error"]["code"] == "EMAIL_NOT_CONFIGURED", r.text
    assert "token=" not in caplog.text and "set-password/confirm" not in caplog.text


async def test_24_the_server_log_of_an_embedded_install_carries_no_verification_link_hosted_logging_is_unchanged(embedded, caplog, monkeypatch):
    """register + resend-verification: the link is a token. Embedded: a line with the user id only. Not embedded: the existing console-fallback line (the operator's use)"""
    import logging

    from httpx import ASGITransport, AsyncClient

    import app.routers.auth as auth_router
    from app.core.rate_limit import limiter

    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("EMAIL_SMTP_HOST", raising=False)
    monkeypatch.setattr(auth_router.resend_verification_limiter, "enabled", False)
    emails = [f"t4825-log-{uuid.uuid4().hex[:8]}@example.com" for _ in range(2)]

    async def _round(email: str) -> str:
        caplog.clear()
        caplog.set_level(logging.DEBUG)
        limiter.reset()
        async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
            reg = await rc.post("/api/v2/auth/register", json={"email": email, "password": "Aa1!aaaaaaaaaa", "display_name": "Log", "tos_accepted": True})
            assert reg.status_code == 201, reg.text
            login = await rc.post("/api/v2/auth/token", json={"email": email, "password": "Aa1!aaaaaaaaaa"})
            hdr = _bearer(login.json()["data"])
            await rc.post("/api/v2/auth/resend-verification", headers=hdr)
        return caplog.text

    try:
        embedded_log = await _round(emails[0])  # the `embedded` fixture: the switch is on
        assert "미발송" not in embedded_log or "verify-email" not in embedded_log
        assert "verify-email" not in embedded_log and "token=" not in embedded_log, embedded_log
        assert embedded_log.count("verification e-mail not sent") == 2  # register + resend-verification, user id only
        monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)  # hosted
        hosted_log = await _round(emails[1])
        assert hosted_log.count("verify-email?token=") == 2, hosted_log  # unchanged: the operator's console fallback
    finally:
        for email in emails:
            await _sql(
                f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '{email}')",
                f"DELETE FROM login_audit_logs WHERE email = '{email}'",
                f"DELETE FROM users WHERE email = '{email}'",
            )


async def test_08_the_real_app_has_no_such_route_unless_embedded():
    """the app main.py builds in this process (no SPRINTABLE_EMBEDDED in the test environment) must not serve the path"""
    if os.environ.get("SPRINTABLE_EMBEDDED"):
        pytest.skip("the suite is running in an embedded environment")
    from httpx import ASGITransport, AsyncClient

    assert URL not in {getattr(r, "path", None) for r in real_app.routes}
    async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False, client=("127.0.0.1", 1)), base_url="http://test") as rc:
        r = await rc.post(URL, headers=_h())
    assert r.status_code in (404, 405)


async def test_09_hosted_register_and_login_are_untouched(embedded):
    """AC4 — a sign-up and a sign-in through the real app behave as before while an embedded app also exists in the process"""
    from httpx import ASGITransport, AsyncClient

    email = f"t4825-{uuid.uuid4().hex[:8]}@example.com"
    try:
        async with AsyncClient(transport=ASGITransport(app=real_app, raise_app_exceptions=False), base_url="http://test") as rc:
            reg = await rc.post("/api/v2/auth/register", json={
                "email": email, "password": "Aa1!aaaaaaaaaa", "display_name": "Hosted", "tos_accepted": True,
            })
            assert reg.status_code == 201, reg.text
            assert reg.json()["data"]["email_delivered"] in (True, False)  # the unverified-account flow is still there
            login = await rc.post("/api/v2/auth/token", json={"email": email, "password": "Aa1!aaaaaaaaaa"})
            assert login.status_code == 200 and login.json()["data"]["access_token"], login.text
            bad = await rc.post("/api/v2/auth/token", json={"email": email, "password": "wrong-password-1A!"})
            assert bad.status_code == 401
        row = await _sql(f"SELECT email_verified FROM users WHERE email = '{email}'", fetch="one")
        assert row.email_verified is False  # a hosted sign-up is NOT verified by this change
    finally:
        await _sql(
            f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '{email}')",
            f"DELETE FROM login_audit_logs WHERE email = '{email}'",
            f"DELETE FROM users WHERE email = '{email}'",
        )
