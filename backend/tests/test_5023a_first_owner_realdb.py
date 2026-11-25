"""story 5023 (B2-2, a) — the first-owner rule of a workspace SERVER and the question `sprintable-host server set-public-origin` asks (`GET /api/v2/server-setup/state`), over real HTTP on a migrated PG (ALEMBIC_DATABASE_URL · DATABASE_URL).

Each test goes red without the line it names:
T1  the rule off (the desktop app · a hosted deployment): sign-up is exactly as before — no setup code, no closing, even with an owner; the state route is not registered at all when the install is not embedded
T2  the rule on, NO owner yet: a sign-up without the setup code is 403 SETUP_CODE_REQUIRED, a wrong one the same; the right one (typed in lower case, with spaces) signs up
T3  the person who made the first organization is the owner → the state says `owner_exists: true, signup_open: false` (the only answer that lets the door open)
T4  the rule on, an owner exists: sign-up is CLOSED — no invitation, the setup code (it no longer matters), an invitation for ANOTHER e-mail, an expired one, a revoked one are each 403 SIGNUP_CLOSED; only the invited e-mail with a pending invitation signs up (and joins the organization)
T5  a closed server does not tell a stranger which addresses exist (a registered e-mail gets SIGNUP_CLOSED, not EMAIL_TAKEN)
T6  the state answers only a caller that is this machine straight on the loopback port: another address, or any proxy header (everything that comes through the web relay carries one) → the same bare 403
T7  the setup code: 4 groups of 4, the same for the same secret, different for another, case · spaces · dashes do not matter, nothing else matches; the sign-up through a provider is under the same rule (pinned in the source: both new-account paths ask the one function)
Every test runs inside ONE outer transaction that is rolled back (the shared test database may already hold owners): the live owners are set aside first, so «no owner yet» is true whatever else is in the database.
"""
from __future__ import annotations

import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]

SECRET = "t5023-" + secrets.token_hex(24)  # 54 chars, fresh per run
STATE = "/api/v2/server-setup/state"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


class World:
    def __init__(self, app, conn) -> None:
        self.app = app
        self.conn = conn

    def session(self) -> AsyncSession:
        return AsyncSession(bind=self.conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

    def client(self, host: str = "127.0.0.1", headers: dict | None = None):
        from httpx import ASGITransport, AsyncClient

        return AsyncClient(transport=ASGITransport(app=self.app, raise_app_exceptions=False, client=(host, 50000)), base_url="http://127.0.0.1", headers=headers or {})


def _build_app(world_ref: list, *, embedded_routes: bool):
    from fastapi import FastAPI
    from fastapi.exceptions import RequestValidationError

    from app.core.rate_limit import limiter
    from app.main import validation_exception_handler
    from app.routers import auth, organizations, server_setup
    from tests.conftest import override_db_and_read

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.include_router(auth.router)
    app.include_router(organizations.router)
    registered = server_setup.register_server_setup_routes(app)
    assert registered is embedded_routes

    async def provider():
        async with world_ref[0].session() as s:
            yield s

    override_db_and_read(app, provider)
    return app


@pytest.fixture
def make_world(monkeypatch):
    """`async with make_world(embedded=True, rule=True) as w:` → a World on one connection inside an outer transaction (rolled back at the end) with every live owner of the shared database set aside.
    Opened INSIDE the test body: the suite runs each async test in its own loop, and a connection made by a fixture would belong to another one."""
    from contextlib import asynccontextmanager

    from app.core.config import settings
    from app.core.rate_limit import limiter

    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    monkeypatch.setattr(settings, "require_verified_email_for_org_create", False)  # what the server host's supervisor sets (no mail on a server)

    @asynccontextmanager
    async def build(*, embedded: bool, rule: bool):
        if embedded:
            monkeypatch.setenv("SPRINTABLE_EMBEDDED", "1")
        else:
            monkeypatch.delenv("SPRINTABLE_EMBEDDED", raising=False)
        monkeypatch.setattr(settings, "server_owner_setup", rule)
        limiter.enabled = False
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        conn = await eng.connect()
        outer = await conn.begin()
        try:
            await conn.execute(text("UPDATE org_members SET deleted_at = now() WHERE role = 'owner' AND deleted_at IS NULL"))
            holder: list = []
            w = World(_build_app(holder, embedded_routes=embedded), conn)
            holder.append(w)
            yield w
        finally:
            limiter.enabled = True
            await outer.rollback()
            await conn.close()
            await eng.dispose()

    return build


def _body(email: str, **extra) -> dict:
    return {"email": email, "password": "Ok-pass-" + secrets.token_hex(6), "display_name": "Five Twenty-three", "tos_accepted": True, **extra}


def _code(r) -> str | None:
    try:
        return r.json()["error"]["code"]
    except Exception:  # noqa: BLE001
        return None


async def _state(w: World) -> dict:
    async with w.client() as c:
        r = await c.get(STATE)
    assert r.status_code == 200, r.text
    return r.json()


async def _register(w: World, **kw):
    async with w.client() as c:
        return await c.post("/api/v2/auth/register", json=_body(**kw))


async def _make_owner(w: World, email: str) -> str:
    """sign up with the setup code and make the first organization — the person becomes its owner; returns the user's e-mail"""
    from app.services import server_owner_setup

    r = await _register(w, email=email, setup_code=server_owner_setup.setup_code())
    assert r.status_code == 201, r.text
    token = r.json()["data"]["access_token"]
    async with w.client(headers={"Authorization": f"Bearer {token}"}) as c:
        o = await c.post("/api/v2/organizations", json={"name": "Five 23 Lab"})
    assert o.status_code == 201, o.text
    return o.json()["data"]["id"] if "data" in o.json() else o.json()["id"]


def _mail(tag: str) -> str:
    return f"{tag}-{secrets.token_hex(4)}@example.com"


async def test_t1_with_the_rule_off_signup_is_as_before_and_the_state_route_needs_an_embedded_install(make_world):
    async with make_world(embedded=False, rule=False) as plain:
        async with plain.client() as c:
            assert (await c.get(STATE)).status_code == 404  # not registered at all off an embedded install
        assert (await _register(plain, email=_mail("a"))).status_code == 201  # no setup code asked for

    async with make_world(embedded=False, rule=True) as stray:  # the switch alone, on an install that is not a workspace server (a hosted deployment): nothing changes
        from app.services import server_owner_setup as so0

        assert so0.enabled() is False
        assert (await _register(stray, email=_mail("s"))).status_code == 201

    async with make_world(embedded=True, rule=False) as app_like:  # the desktop app: embedded, the rule off
        assert await _state(app_like) == {"owner_exists": False, "signup_open": True}
        assert (await _register(app_like, email=_mail("b"))).status_code == 201
        # even with an owner a sign-up stays open there — and the state says so, so the door is never opened on such a server
        from app.services import server_owner_setup

        r = await _register(app_like, email=_mail("c"))
        token = r.json()["data"]["access_token"]
        async with app_like.client(headers={"Authorization": f"Bearer {token}"}) as c:
            assert (await c.post("/api/v2/organizations", json={"name": "App Lab"})).status_code == 201
        assert server_owner_setup.enabled() is False
        assert await _state(app_like) == {"owner_exists": True, "signup_open": True}
        assert (await _register(app_like, email=_mail("d"))).status_code == 201


async def test_t2_no_owner_yet_a_signup_needs_the_setup_code(make_world):
    from app.services import server_owner_setup

    async with make_world(embedded=True, rule=True) as w:
        assert await _state(w) == {"owner_exists": False, "signup_open": True}
        none = await _register(w, email=_mail("n"))
        assert none.status_code == 403 and _code(none) == "SETUP_CODE_REQUIRED"
        for wrong in ["", "AAAA-AAAA-AAAA-AAAA", server_owner_setup.setup_code()[:-1], server_owner_setup.setup_code() + "A", "owner"]:
            r = await _register(w, email=_mail("w"), setup_code=wrong)
            assert r.status_code == 403 and _code(r) == "SETUP_CODE_REQUIRED", wrong
        # the provider sign-up asks with NO setup code (by design a provider can never make the FIRST owner of a server): refused while there is no owner
        async with w.session() as s:
            assert await server_owner_setup.signup_refusal(s, email=_mail("p"), setup_code_given=None, invite_token=None) == ("SETUP_CODE_REQUIRED", "This server has no owner yet: sign up with the setup code shown by `sprintable-host server status` on the server")
        typed = server_owner_setup.setup_code().lower().replace("-", " ")
        ok = await _register(w, email=_mail("ok"), setup_code=typed)
        assert ok.status_code == 201, ok.text
        assert SECRET not in none.text and SECRET not in ok.text and server_owner_setup.setup_code() not in none.text


async def test_t3_the_first_organizations_maker_is_the_owner_and_the_state_then_lets_the_door_open(make_world):
    async with make_world(embedded=True, rule=True) as w:
        assert await _state(w) == {"owner_exists": False, "signup_open": True}
        await _make_owner(w, _mail("own"))
        st = await _state(w)
        assert st == {"owner_exists": True, "signup_open": False}  # exactly what `set-public-origin` waits for
        # a server whose only people are admins and members has NO owner; a removed owner is no owner either
        async with w.session() as s:
            await s.execute(text("UPDATE org_members SET role = 'admin' WHERE role = 'owner' AND deleted_at IS NULL"))
            await s.commit()
        assert (await _state(w))["owner_exists"] is False
        async with w.session() as s:
            await s.execute(text("UPDATE org_members SET role = 'owner' WHERE role = 'admin' AND deleted_at IS NULL AND created_at > now() - interval '1 hour'"))
            await s.commit()
        assert (await _state(w))["owner_exists"] is True
        async with w.session() as s:
            await s.execute(text("UPDATE org_members SET deleted_at = now() WHERE role = 'owner' AND deleted_at IS NULL"))
            await s.commit()
        assert (await _state(w))["owner_exists"] is False


async def test_t4_with_an_owner_signup_is_closed_except_for_the_invited_address(make_world):
    from app.models.org_invite import OrgInvite
    from app.services import server_owner_setup

    async with make_world(embedded=True, rule=True) as w:
        org_id = await _make_owner(w, _mail("own"))
        assert (await _register(w, email=_mail("x"))).status_code == 403
        r0 = await _register(w, email=_mail("x"))
        assert _code(r0) == "SIGNUP_CLOSED"
        withcode = await _register(w, email=_mail("x"), setup_code=server_owner_setup.setup_code())
        assert withcode.status_code == 403 and _code(withcode) == "SIGNUP_CLOSED"  # the setup code no longer opens anything

        invited = _mail("inv")
        now = datetime.now(timezone.utc)
        async with w.session() as s:
            good = OrgInvite(organization_id=uuid.UUID(org_id), email=invited.upper(), role="member", status="pending", expires_at=now + timedelta(days=7))
            other = OrgInvite(organization_id=uuid.UUID(org_id), email=_mail("other"), role="member", status="pending", expires_at=now + timedelta(days=7))
            expired = OrgInvite(organization_id=uuid.UUID(org_id), email=_mail("exp"), role="member", status="pending", expires_at=now - timedelta(minutes=1))
            revoked = OrgInvite(organization_id=uuid.UUID(org_id), email=_mail("rev"), role="member", status="revoked", expires_at=now + timedelta(days=7))
            accepted = OrgInvite(organization_id=uuid.UUID(org_id), email=_mail("acc"), role="member", status="accepted", expires_at=now + timedelta(days=7))
            s.add_all([good, other, expired, revoked, accepted])
            await s.commit()
            tokens = {"good": good.token, "other": other.token, "expired": expired.token, "revoked": revoked.token, "accepted": accepted.token}
            mails = {"expired": expired.email, "revoked": revoked.email, "accepted": accepted.email}
        # an invitation made for ANOTHER e-mail does not open it, nor does one that is expired, revoked or already used
        stolen = await _register(w, email=_mail("thief"), invite_token=tokens["other"])
        assert stolen.status_code == 403 and _code(stolen) == "SIGNUP_CLOSED"
        for name in ("expired", "revoked", "accepted"):
            r = await _register(w, email=mails[name], invite_token=tokens[name])
            assert r.status_code == 403 and _code(r) == "SIGNUP_CLOSED", name
        unknown = await _register(w, email=invited, invite_token="no-such-token")
        assert unknown.status_code == 403 and _code(unknown) == "SIGNUP_CLOSED"
        # the provider sign-up (no setup code): an owner exists → only the invited address with its pending invitation gets in
        async with w.session() as s:
            assert (await server_owner_setup.signup_refusal(s, email=_mail("p"), setup_code_given=None, invite_token=None))[0] == "SIGNUP_CLOSED"
            assert await server_owner_setup.signup_refusal(s, email=invited, setup_code_given=None, invite_token=tokens["good"]) is None
            assert (await server_owner_setup.signup_refusal(s, email=invited, setup_code_given=None, invite_token=tokens["other"]))[0] == "SIGNUP_CLOSED"
        # the invitation was written in upper case, the person types lower case: the same address (the accept path compares the same way) — an invitation is for the person, not for a spelling
        ok = await _register(w, email=invited, invite_token=tokens["good"])
        assert ok.status_code == 201, ok.text
        async with w.session() as s:
            n = (await s.execute(text("SELECT count(*) FROM org_members om JOIN users u ON u.id = om.user_id WHERE lower(u.email) = :e AND om.org_id = :o AND om.deleted_at IS NULL"), {"e": invited.lower(), "o": org_id})).scalar_one()
        assert n == 1  # the invited person joined the organization


async def test_t5_a_closed_server_does_not_tell_which_addresses_exist(make_world):
    async with make_world(embedded=True, rule=True) as w:
        owner_mail = _mail("own")
        await _make_owner(w, owner_mail)
        r = await _register(w, email=owner_mail)
        assert r.status_code == 403 and _code(r) == "SIGNUP_CLOSED"
        assert _code(await _register(w, email=_mail("never"))) == "SIGNUP_CLOSED"  # the same answer for an address nobody has


async def test_t6_the_state_answers_only_this_machine_straight_on_the_loopback_port(make_world):
    async with make_world(embedded=True, rule=True) as w:
        async with w.client(host="203.0.113.7") as c:
            far = await c.get(STATE)
        assert far.status_code == 403 and far.json() == {"data": None, "error": {"code": "FORBIDDEN", "message": "Forbidden"}, "meta": None}
        for h in ({"X-Forwarded-For": "1.2.3.4"}, {"Forwarded": "for=1.2.3.4"}, {"X-Real-IP": "1.2.3.4"}):
            async with w.client(headers=h) as c:
                r = await c.get(STATE)
            assert r.status_code == 403, h
        async with w.client(host="::1") as c:
            assert (await c.get(STATE)).status_code == 200
        # a mis-wired app that carries the router while the install is NOT embedded still answers the bare 403
        import os as _os
        from fastapi import FastAPI
        from app.routers import server_setup as _ss

        _os.environ.pop("SPRINTABLE_EMBEDDED", None)
        stray = FastAPI(); stray.include_router(_ss.router)
        from tests.conftest import override_db_and_read

        async def _p():
            async with w.session() as s:
                yield s

        override_db_and_read(stray, _p)
        from httpx import ASGITransport, AsyncClient

        async with AsyncClient(transport=ASGITransport(app=stray, raise_app_exceptions=False, client=("127.0.0.1", 50000)), base_url="http://127.0.0.1") as c:
            assert (await c.get(STATE)).status_code == 403
        _os.environ["SPRINTABLE_EMBEDDED"] = "1"
        async with w.client() as c:
            r = await c.get(STATE)
        assert r.status_code == 200 and r.headers.get("cache-control") == "no-store" and set(r.json()) == {"owner_exists", "signup_open"}


async def test_t7_the_setup_code_and_the_two_ways_to_make_an_account(monkeypatch):
    from app.core.config import settings
    from app.services import server_owner_setup as so

    monkeypatch.setattr(settings, "local_bootstrap_secret", SECRET)
    code = so.setup_code()
    assert re.fullmatch(r"[A-Z2-7]{4}(-[A-Z2-7]{4}){3}", code) and so.setup_code() == code
    assert so.code_matches(code) and so.code_matches(code.lower()) and so.code_matches(f" {code.replace('-', '  ')} ")
    assert not so.code_matches(None) and not so.code_matches("") and not so.code_matches(code[:-1]) and not so.code_matches(code + "A")
    monkeypatch.setattr(settings, "local_bootstrap_secret", "t5023-other-" + secrets.token_hex(24))
    assert so.setup_code() != code and not so.code_matches(code)
    # both places that make a NEW account (the password sign-up and the provider sign-up) ask the one function before they write anything
    src = (Path(__file__).resolve().parent.parent / "app" / "routers" / "auth.py").read_text(encoding="utf-8")
    assert src.count("server_owner_setup.signup_refusal(") == 2
    reg = src.index("async def register(")
    assert src.index("server_owner_setup.signup_refusal(", reg) < src.index("session.add(user)", reg)
    oauth = src.index("async def oauth_callback(")
    assert src.index("server_owner_setup.signup_refusal(", oauth) < src.index("session.add(user)", oauth)
