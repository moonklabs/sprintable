"""story 4762 — signing in follows the same live-org rule as a refresh.

Before: `login` (and the OAuth callback) built the token with `_build_app_metadata(user, session)`, which scopes to `user.last_org_id` without asking whether the
person is still a member of it. A person removed from org A who is still in org B signed in with an A claim: `GET /api/v2/me` answered 404
`membership_elsewhere`, the web layout sent them to the sign-in, and the next sign-in gave the same claim — a loop with no way out. The sign-in now uses
`_sign_in_session_context` (= `_refresh_session_context` with no session org): `last_org_id` while it is a live membership, else the oldest live org, else a
claim without an org.

Real PG, the real endpoints, a person with two orgs.
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

_PASSWORD = "pw-" + "4762"


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
    def __init__(self, app, Session, client, user_id, email, orgs):
        self.app, self.Session, self.client = app, Session, client
        self.user_id, self.email, self.orgs = user_id, email, orgs

    async def login(self) -> dict:
        resp = await self.client.post("/api/v2/auth/token", json={"email": self.email, "password": _PASSWORD})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    async def leave(self, org_id) -> None:
        from sqlalchemy import update

        from app.models.project import OrgMember

        async with self.Session() as s:
            await s.execute(update(OrgMember).where(OrgMember.user_id == self.user_id, OrgMember.org_id == org_id)
                            .values(deleted_at=datetime.now(timezone.utc)))
            await s.commit()

    async def last_org_id(self):
        from app.models.user import User

        async with self.Session() as s:
            return (await s.get(User, self.user_id)).last_org_id


def _org_claim(tokens: dict) -> str | None:
    from app.core.security import decode_jwt
    return (decode_jwt(tokens["access_token"]).get("app_metadata") or {}).get("org_id")


async def _world(org_count: int = 2, last_org_index: int = 0):
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
    email = f"story4762-{user_id.hex[:8]}@test.com"
    orgs = []
    async with Session() as s:
        s.add(User(id=user_id, email=email, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
        await s.commit()
        for n in range(1, org_count + 1):
            org = Organization(id=uuid.uuid4(), name=f"Org{n}", slug=f"o4762-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            s.add(Project(id=uuid.uuid4(), org_id=org.id, name=f"P{n}"))
            # owner: project access through the org role (team_members is a read-only view)
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="owner",
                            created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            await s.commit()
            orgs.append(org.id)
        user = await s.get(User, user_id)
        user.last_org_id = orgs[last_org_index]
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
    return engine, _World(app, Session, client, user_id, email, orgs)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


async def test_sign_in_after_leaving_the_last_org_lands_in_the_org_the_person_is_still_in():
    """removed from A (last_org_id = A), still in B → the sign-in carries B, not A (the loop the web layout's membership_elsewhere redirect would otherwise run)."""
    engine, w = await _world()
    try:
        a, b = w.orgs
        assert _org_claim(await w.login()) == str(a)  # control: a live last_org_id is kept
        await w.leave(a)
        tokens = await w.login()
        assert _org_claim(tokens) == str(b)
        # the session is usable: /me answers for that org instead of 404 membership_elsewhere
        me = await w.client.get("/api/v2/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
        assert me.status_code == 200, me.text
    finally:
        await _close(engine, w)


async def test_sign_in_keeps_a_live_last_org_even_when_it_is_not_the_oldest():
    engine, w = await _world(last_org_index=1)
    try:
        assert _org_claim(await w.login()) == str(w.orgs[1])
    finally:
        await _close(engine, w)


async def test_sign_in_with_several_live_orgs_and_a_stale_last_org_takes_the_oldest_live_one():
    """the refresh rule: `live_orgs[0]` (oldest membership first)."""
    engine, w = await _world(org_count=3, last_org_index=2)
    try:
        await w.leave(w.orgs[2])
        assert _org_claim(await w.login()) == str(w.orgs[0])
    finally:
        await _close(engine, w)


async def test_sign_in_with_no_live_org_left_carries_no_org_claim_and_clears_the_stale_last_org():
    """every membership left → the state of a new sign-up (no claim → /me answers `no_membership`, the onboarding path), never a departed org."""
    engine, w = await _world()
    try:
        for org in w.orgs:
            await w.leave(org)
        tokens = await w.login()
        assert not _org_claim(tokens)
        assert await w.last_org_id() is None
    finally:
        await _close(engine, w)


async def test_a_membership_orphaned_by_a_deleted_org_is_not_a_landing_place_for_a_sign_in():
    """org_members.org_id has no foreign key: a hard-deleted org can leave a membership row with deleted_at NULL (same case as the refresh test in 4400)."""
    from sqlalchemy import delete

    from app.models.organization import Organization

    engine, w = await _world()
    try:
        async with w.Session() as s:
            await s.execute(delete(Organization).where(Organization.id == w.orgs[0]))
            await s.commit()
        assert _org_claim(await w.login()) == str(w.orgs[1])
    finally:
        await _close(engine, w)


# ── mutations: each re-opens the defect ────────────────────────────────────────

async def test_mutation_sign_in_that_trusts_last_org_id_again_issues_the_departed_org(monkeypatch):
    from app.routers import auth as auth_module

    async def _trusting(user, session):
        return await auth_module._build_app_metadata(user, session)

    monkeypatch.setattr(auth_module, "_sign_in_session_context", _trusting)
    engine, w = await _world()
    try:
        await w.leave(w.orgs[0])
        tokens = await w.login()
        # the pre-4762 defect: the token does not name the org the person is still in
        assert _org_claim(tokens) != str(w.orgs[1])
    finally:
        await _close(engine, w)


def test_both_sign_in_roads_use_the_one_helper():
    """login and the OAuth callback build their claim in ONE place; a new sign-in road that calls `_build_app_metadata(user, session)` again is the defect back.
    (`register` is a brand-new person with no last_org_id — it stays on `_build_app_metadata`.)"""
    import inspect

    from app.routers import auth as auth_module

    for fn in (auth_module.login, auth_module.oauth_callback):
        src = inspect.getsource(fn)
        assert "_sign_in_session_context(user, session)" in src, fn.__name__
        assert "_build_app_metadata(user, session)" not in src, fn.__name__
