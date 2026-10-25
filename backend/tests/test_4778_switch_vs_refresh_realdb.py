"""story 4778 — AC1: does a refresh that overlaps an org / project switch of the SAME session log the person out?

The web page sends `sp_rt` (the refresh cookie) with every call it makes: the BFF `switch-org` / `switch-project` routes and the BFF `/api/auth/refresh` route all read the cookie the browser held
when the request LEFT. A switch revokes that token explicitly (story 4400: this session's token only; story 3649: the revoke also takes the token out of the refresh grace window, so it is
refused even inside `auth_refresh_chain_resolve_window_seconds`) and answers with a new one. A refresh that left with the OLD token before the browser saved the switch's new cookie therefore has
two outcomes, decided only by which of the two commits first:

* the refresh commits first: it rotates the token, the switch then finds the token already revoked (it does not look at the row count) and still issues its own token: two live tokens, both renew;
* the switch commits first: the refresh answers 401 — and the BFF refresh route clears BOTH cookies on a 401 (apps/web/src/app/api/auth/refresh/route.ts): a forced logout while switching, even though the
  switch itself succeeded (its answer carried a live token the cleared cookies no longer hold).

This file pins the server half (real PG, the real endpoints): the two deterministic orders, and a concurrent race whose every outcome is one of the two.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real PG (PARITY/ALEMBIC_DATABASE_URL) needed"),
    pytest.mark.anyio,
]

_PASSWORD = "pw-" + "4778"
RACE_TRIALS = int(os.getenv("STORY_4778_RACE_TRIALS", "12"))


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
    def __init__(self, app, client, user_id, email, org1, org2, project1):
        self.app, self.client = app, client
        self.user_id, self.email, self.org1, self.org2, self.project1 = user_id, email, org1, org2, project1

    async def login(self) -> dict:
        resp = await self.client.post("/api/v2/auth/token", json={"email": self.email, "password": _PASSWORD})
        assert resp.status_code == 200, resp.text
        return resp.json()["data"]

    def refresh(self, rt: str):
        return self.client.post("/api/v2/auth/refresh", json={"refresh_token": rt})

    def switch_org(self, tokens: dict, org_id):
        return self.client.post(
            "/api/v2/auth/switch-org", json={"org_id": str(org_id), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )

    def switch_project(self, tokens: dict, project_id):
        return self.client.post(
            "/api/v2/auth/switch-project", json={"project_id": str(project_id), "refresh_token": tokens["refresh_token"]},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )


async def _world() -> tuple:
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.security import hash_password
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User
    from tests.conftest import override_db_and_read  # story 2451: get_db is overridden only through this helper (it also covers get_read_db)

    engine = create_async_engine(_async_url())
    Session = async_sessionmaker(engine, expire_on_commit=False)
    user_id = uuid.uuid4()
    email = f"story4778-{user_id.hex[:8]}@test.com"
    orgs, project1 = [], None
    async with Session() as s:
        s.add(User(id=user_id, email=email, hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
        await s.commit()
        for n in (1, 2):
            org = Organization(id=uuid.uuid4(), name=f"Org{n}", slug=f"o4778-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name=f"P{n}")
            s.add(project)
            s.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="owner", created_at=datetime.now(timezone.utc) + timedelta(seconds=n)))
            await s.commit()
            orgs.append(org.id)
            project1 = project1 or project.id
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
    return engine, _World(app, client, user_id, email, orgs[0], orgs[1], project1)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


def _switchers(w: _World):
    return {"org": lambda tokens: w.switch_org(tokens, w.org2), "project": lambda tokens: w.switch_project(tokens, w.project1)}


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_a_refresh_that_left_with_the_old_token_after_a_switch_is_refused_even_inside_the_window_realdb(kind):
    """the logout half: switch committed first → the old token is dead at once (not a race loser) → 401 → the BFF refresh route clears both cookies"""
    engine, w = await _world()
    try:
        a = await w.login()
        sw = await _switchers(w)[kind](a)
        assert sw.status_code == 200, sw.text
        late = await w.refresh(a["refresh_token"])  # left with the cookie the browser still held; seconds after, far inside the 180 s window
        assert late.status_code == 401, f"the old token of a switched session must be dead: {late.status_code} {late.text}"
        assert late.json()["error"]["code"] == "TOKEN_REVOKED"
        # the switch's own answer holds a live token: only the cleared cookies lose it
        again = await w.refresh(sw.json()["data"]["refresh_token"])
        assert again.status_code == 200, again.text
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_a_switch_after_a_refresh_with_the_same_token_leaves_two_live_tokens_realdb(kind):
    """the surviving half: refresh committed first → the switch revokes nothing (row already revoked) and still issues a token → every cookie the browser can end with is alive"""
    engine, w = await _world()
    try:
        a = await w.login()
        rotated = await w.refresh(a["refresh_token"])
        assert rotated.status_code == 200, rotated.text
        sw = await _switchers(w)[kind](a)  # left before the browser saved the refresh's cookie: same old token
        assert sw.status_code == 200, sw.text
        for answer in (rotated, sw):
            assert (await w.refresh(answer.json()["data"]["refresh_token"])).status_code == 200
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_a_refresh_racing_a_switch_either_survives_or_is_refused_never_anything_else_realdb(kind):
    """both leave with the same cookie at once: every trial is one of the two orders; the number of refused refreshes is printed (run with -s)"""
    engine, w = await _world()
    refused = 0
    try:
        for _ in range(RACE_TRIALS):
            a = await w.login()
            sw, rf = await asyncio.gather(_switchers(w)[kind](a), w.refresh(a["refresh_token"]))
            assert sw.status_code == 200, f"the switch itself must not fail: {sw.status_code} {sw.text}"
            assert rf.status_code in (200, 401), rf.text
            assert (await w.refresh(sw.json()["data"]["refresh_token"])).status_code == 200, "the switch's token must be live"
            if rf.status_code == 200:
                assert (await w.refresh(rf.json()["data"]["refresh_token"])).status_code == 200, "the refresh's token must be live"
            else:
                refused += 1
        print(f"\n[4778 race:{kind}] trials={RACE_TRIALS} refresh refused (would clear both cookies)={refused}")
    finally:
        await _close(engine, w)
