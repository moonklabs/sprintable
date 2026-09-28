"""story #4400 — each session keeps its own org; switching org / project revokes only the switching session.

Before: switch-org / switch-project revoked every refresh token of the person (all devices), and a refresh re-issued the
person-wide `user.last_org_id`. Opening another org's scoped link (the web shell's automatic switch, #2545) therefore
signed the person out on every other device. The refresh token row now carries its session's org and project, a refresh
re-issues that org while the person is still a live member of it, and a switch revokes only the token the BFF sends.

Two real sessions (two password logins) of one person in two orgs, real PG, the real endpoints.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PASSWORD = "pw-" + "4400"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    from app.core.rate_limit import limiter
    monkeypatch.setattr(limiter, "enabled", False)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


class _World:
    def __init__(self, app, Session, client, user_id, email, org1, org2):
        self.app, self.Session, self.client = app, Session, client
        self.user_id, self.email, self.org1, self.org2 = user_id, email, org1, org2

    async def login(self) -> dict:
        resp = await self.client.post("/api/v2/auth/token", json={"email": self.email, "password": _PASSWORD})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    async def refresh(self, rt: str):
        return await self.client.post("/api/v2/auth/refresh", json={"refresh_token": rt})

    async def switch_org(self, tokens: dict, org_id, *, send_rt: bool = True):
        body = {"org_id": str(org_id)}
        if send_rt:
            body["refresh_token"] = tokens["refresh_token"]
        resp = await self.client.post(
            "/api/v2/auth/switch-org", json=body, headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]


def _org_claim(tokens: dict) -> str | None:
    from app.core.security import decode_jwt
    return (decode_jwt(tokens["access_token"]).get("app_metadata") or {}).get("org_id")


async def _world():
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.security import hash_password
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User
    from tests.conftest import override_db_and_read

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    user_id = uuid.uuid4()
    email = f"story4400-{user_id.hex[:8]}@test.com"
    orgs = []
    async with Session() as s:
        s.add(User(id=user_id, email=email, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
        await s.commit()
        for n in (1, 2):
            org = Organization(id=uuid.uuid4(), name=f"Org{n}", slug=f"o4400-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            s.add(Project(id=uuid.uuid4(), org_id=org.id, name=f"P{n}"))
            # owner: project access through the org role (team_members is a read-only view)
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="owner",
                            created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            await s.commit()
            orgs.append(org.id)
        user = await s.get(User, user_id)
        user.last_org_id = orgs[0]
        await s.commit()

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return engine, _World(app, Session, client, user_id, email, orgs[0], orgs[1])


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


async def _two_sessions_after_a_switches(w: _World):
    a, b = await w.login(), await w.login()
    assert _org_claim(a) == _org_claim(b) == str(w.org1)
    a2 = await w.switch_org(a, w.org2)
    assert _org_claim(a2) == str(w.org2)
    return a, a2, b


async def test_switching_org_on_one_session_keeps_the_other_session_and_its_org():
    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        rb = await w.refresh(b["refresh_token"])
        assert rb.status_code == 200, rb.text  # B was not signed out
        assert _org_claim(rb.json()["data"]) == str(w.org1)  # and did not follow A into org2
        ra = await w.refresh(a2["refresh_token"])
        assert ra.status_code == 200, ra.text
        assert _org_claim(ra.json()["data"]) == str(w.org2)  # A keeps the org it switched to
        # B again after A's refresh (last_org_id is org2 now): still org1
        rb2 = await w.refresh(rb.json()["data"]["refresh_token"])
        assert _org_claim(rb2.json()["data"]) == str(w.org1)
        # the switching session's own previous token is revoked
        assert (await w.refresh(a["refresh_token"])).status_code == 401
    finally:
        await _close(engine, w)


async def test_a_session_whose_org_was_left_goes_back_to_an_org_it_is_still_in():
    from sqlalchemy import update

    from app.models.project import OrgMember

    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        rb = await w.refresh(b["refresh_token"])  # B's refresh writes last_org_id = org1 again
        assert _org_claim(rb.json()["data"]) == str(w.org1)
        async with w.Session() as s:
            await s.execute(update(OrgMember).where(OrgMember.user_id == w.user_id, OrgMember.org_id == w.org1)
                            .values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()
        rb2 = await w.refresh(rb.json()["data"]["refresh_token"])
        assert rb2.status_code == 200, rb2.text
        assert _org_claim(rb2.json()["data"]) == str(w.org2)  # neither the session's org nor last_org_id: they left it
    finally:
        await _close(engine, w)


async def test_password_change_still_signs_out_every_session_3649():
    from app.models.user import User

    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        async with w.Session() as s:
            user = await s.get(User, w.user_id)
            user.password_set_at = datetime.now(timezone.utc) + timedelta(seconds=5)
            await s.commit()
        for rt in (a2["refresh_token"], b["refresh_token"]):
            resp = await w.refresh(rt)
            assert resp.status_code == 401, resp.text
            assert resp.json()["error"]["code"] == "SESSION_INVALIDATED"
    finally:
        await _close(engine, w)


async def test_logout_is_untouched_it_ends_only_its_own_session():
    """logout revokes the token it is given (develop behaviour, unchanged here) — not every device."""
    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        assert (await w.client.post("/api/v2/auth/logout", json={"refresh_token": a2["refresh_token"]})).status_code == 200
        assert (await w.refresh(a2["refresh_token"])).status_code == 401
        assert (await w.refresh(b["refresh_token"])).status_code == 200
    finally:
        await _close(engine, w)


async def test_a_switch_without_the_token_keeps_the_previous_all_device_revoke_and_logs_it(caplog):
    """A caller that does not send its refresh token yet (an older web pod during a deploy): previous behaviour, and one
    structured line per use (PO 21:35Z) so the fallback can be removed once it reads 0."""
    import logging

    engine, w = await _world()
    try:
        a, b = await w.login(), await w.login()
        with caplog.at_level(logging.INFO, logger="app.routers.auth"):
            await w.switch_org(a, w.org2, send_rt=False)
        assert (await w.refresh(b["refresh_token"])).status_code == 401
        lines = [r for r in caplog.records if getattr(r, "structured", {}).get("event") == "switch_revoke_fallback"]
        assert len(lines) == 1
        assert lines[0].structured == {"event": "switch_revoke_fallback", "route": "switch-org", "revoked": 2}
        assert str(w.user_id) not in lines[0].getMessage() + repr(lines[0].structured)
    finally:
        await _close(engine, w)


async def test_a_switch_with_the_token_logs_no_fallback(caplog):
    import logging

    engine, w = await _world()
    try:
        a = await w.login()
        with caplog.at_level(logging.INFO, logger="app.routers.auth"):
            await w.switch_org(a, w.org2)
        assert not [r for r in caplog.records if getattr(r, "structured", {}).get("event") == "switch_revoke_fallback"]
    finally:
        await _close(engine, w)


async def test_a_token_issued_before_4400_follows_last_org_id_once_then_carries_its_org():
    from sqlalchemy import select, update

    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, w = await _world()
    try:
        b = await w.login()
        async with w.Session() as s:  # what a pre-#4400 row looks like
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(b["refresh_token"]))
                            .values(org_id=None, project_id=None))
            await s.commit()
        rb = await w.refresh(b["refresh_token"])
        assert _org_claim(rb.json()["data"]) == str(w.org1)  # last_org_id
        async with w.Session() as s:
            row = (await s.execute(select(RefreshToken).where(
                RefreshToken.token_hash == hash_token(rb.json()["data"]["refresh_token"])))).scalar_one()
        assert row.org_id == w.org1
    finally:
        await _close(engine, w)


# ── mutations: each re-opens the defect ────────────────────────────────────────

async def test_mutation_switch_revoking_every_token_signs_the_other_session_out(monkeypatch):
    from app.routers import auth as auth_module

    real = auth_module._revoke_switching_session
    monkeypatch.setattr(
        auth_module, "_revoke_switching_session",
        lambda session, user, rt, *, route: real(session, user, None, route=route),
    )
    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        assert (await w.refresh(b["refresh_token"])).status_code == 401  # the pre-#4400 defect is back
    finally:
        await _close(engine, w)


async def test_mutation_refresh_ignoring_the_token_org_makes_the_other_session_follow(monkeypatch):
    from app.routers import auth as auth_module

    async def _person_wide(user, session, rt_org_id, rt_project_id):
        return await auth_module._build_app_metadata(user, session)

    monkeypatch.setattr(auth_module, "_refresh_session_context", _person_wide)
    engine, w = await _world()
    try:
        a, a2, b = await _two_sessions_after_a_switches(w)
        rb = await w.refresh(b["refresh_token"])
        assert rb.status_code == 200
        assert _org_claim(rb.json()["data"]) == str(w.org2)  # B silently followed A: the ping-pong source
    finally:
        await _close(engine, w)


# ── Qadir 01a0e9fc (PO 22:06Z): never re-issue a departed org ─────────────────────────────────────────────────────

async def test_no_live_org_left_issues_a_claim_without_an_org():
    from sqlalchemy import update

    from app.models.project import OrgMember

    engine, w = await _world()
    try:
        b = await w.login()
        async with w.Session() as s:
            await s.execute(update(OrgMember).where(OrgMember.user_id == w.user_id)
                            .values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()
        rb = await w.refresh(b["refresh_token"])
        assert rb.status_code == 200, rb.text  # the state of a new sign-up, not 401
        assert not _org_claim(rb.json()["data"])  # neither the session's org nor the stale last_org_id
    finally:
        await _close(engine, w)


async def test_a_membership_orphaned_by_a_deleted_org_is_not_live():
    """org_members.org_id has no foreign key: a hard-deleted org can leave a membership row with deleted_at NULL."""
    from sqlalchemy import delete

    from app.models.organization import Organization

    engine, w = await _world()
    try:
        b = await w.login()
        assert _org_claim(b) == str(w.org1)
        async with w.Session() as s:
            await s.execute(delete(Organization).where(Organization.id == w.org1))
            await s.commit()
        rb = await w.refresh(b["refresh_token"])
        assert rb.status_code == 200, rb.text
        assert _org_claim(rb.json()["data"]) == str(w.org2)
    finally:
        await _close(engine, w)


async def test_deleting_the_account_ends_every_session():
    engine, w = await _world()
    try:
        a, b = await w.login(), await w.login()
        resp = await w.client.post("/api/v2/account/delete", headers={"Authorization": f"Bearer {a['access_token']}"})
        assert resp.status_code == 200, resp.text
        for rt in (a["refresh_token"], b["refresh_token"]):
            assert (await w.refresh(rt)).status_code == 401
    finally:
        await _close(engine, w)
