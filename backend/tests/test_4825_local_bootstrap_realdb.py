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
    await _wipe_owner()
    app = FastAPI()
    app.state.limiter = limiter
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
