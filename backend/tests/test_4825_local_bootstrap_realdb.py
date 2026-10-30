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
