"""story 4778 — AC1: does a refresh that overlaps an org / project switch of the SAME session log the person out?

The web page sends `sp_rt` (the refresh cookie) with every call it makes: the BFF `switch-org` / `switch-project` routes and the BFF `/api/auth/refresh` route all read the cookie the browser held
when the request LEFT. A switch revokes that token explicitly (story 4400: this session's token only; story 3649: the revoke also takes the token out of the refresh grace window, so it is
refused even inside `auth_refresh_chain_resolve_window_seconds`) and answers with a new one. A refresh that left with the OLD token before the browser saved the switch's new cookie therefore has
two outcomes, decided only by which of the two commits first:

* the refresh commits first: it rotates the token, the switch then finds the token already revoked (it does not look at the row count) and still issues its own token: two live tokens, both renew;
* the switch commits first: the refresh answers 401 — and the BFF refresh route clears BOTH cookies on a 401 (apps/web/src/app/api/auth/refresh/route.ts): a forced logout while switching, even though the
  switch itself succeeded (its answer carried a live token the cleared cookies no longer hold).

This file pins the server half (real PG, the real endpoints): the two deterministic orders, and a concurrent race whose every outcome is one of the two.

story 4778 AC2b — the server tells the two apart: a token ended by a SWITCH a moment ago is answered `TOKEN_SUPERSEDED` (this session moved on and holds a newer token; no new token is ever issued for it), every other end
stays `TOKEN_REVOKED` (logout · password change · a rotation older than the resolve window · past the short superseded window). The BFF and the proxy clear the cookies only on the second.
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
    def __init__(self, app, client, user_id, email, org1, org2, project1, Session):
        self.app, self.client, self.Session = app, client, Session
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
    return engine, _World(app, client, user_id, email, orgs[0], orgs[1], project1, Session)


async def _close(engine, w: _World):
    await w.client.aclose()
    w.app.dependency_overrides.clear()
    await engine.dispose()


async def _token_rows(w: _World) -> int:
    from sqlalchemy import func, select

    from app.models.user import RefreshToken
    async with w.Session() as s:
        return int((await s.execute(select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == w.user_id))).scalar_one())


async def _end_every_session_like_a_logout(w: _World) -> None:
    """what a logout / a password change does to every live token of the person (the seam `_explicit_revoke_values`: revoked_at and expires_at set together, no successor)"""
    from sqlalchemy import update

    from app.models.user import RefreshToken
    now = datetime.now(timezone.utc)
    async with w.Session() as s:
        await s.execute(update(RefreshToken).where(RefreshToken.user_id == w.user_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now, expires_at=now))
        await s.commit()


def _switchers(w: _World):
    return {"org": lambda tokens: w.switch_org(tokens, w.org2), "project": lambda tokens: w.switch_project(tokens, w.project1)}


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_a_refresh_that_left_with_the_old_token_after_a_switch_is_superseded_not_revoked_realdb(kind):
    """the half that used to log the person out: switch committed first → the old token is not a race loser (never renewed) → 401 — but the word is TOKEN_SUPERSEDED, so the BFF does not clear the cookies; and no new token is issued for it"""
    engine, w = await _world()
    try:
        a = await w.login()
        sw = await _switchers(w)[kind](a)
        assert sw.status_code == 200, sw.text
        rows_before = await _token_rows(w)
        late = await w.refresh(a["refresh_token"])  # left with the cookie the browser still held; seconds after, far inside the 180 s window
        assert late.status_code == 401, f"the old token of a switched session must never be exchanged: {late.status_code} {late.text}"
        assert late.json()["error"]["code"] == "TOKEN_SUPERSEDED"  # reverted (the switch records no successor) → TOKEN_REVOKED → the BFF clears both cookies
        assert late.headers.get("x-auth-correlation"), "the BFF pairs its log line with the backend's by this header"
        assert await _token_rows(w) == rows_before, "a superseded token mints nothing"
        again = await w.refresh(a["refresh_token"])  # and it stays refused: no number of tries turns it into a token
        assert again.status_code == 401 and again.json()["error"]["code"] == "TOKEN_SUPERSEDED"
        # the switch's own answer holds a live token: only the cleared cookies lose it
        again = await w.refresh(sw.json()["data"]["refresh_token"])
        assert again.status_code == 200, again.text
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_a_refresh_with_the_old_token_is_still_superseded_when_the_session_moved_on_through_a_rotation_realdb(kind):
    """switch, then the browser's refresh rotated the switch's token: the chain O → S → T ends in a live token, so a late O is still «moved on»"""
    engine, w = await _world()
    try:
        a = await w.login()
        sw = await _switchers(w)[kind](a)
        assert sw.status_code == 200, sw.text
        rot = await w.refresh(sw.json()["data"]["refresh_token"])
        assert rot.status_code == 200, rot.text
        late = await w.refresh(a["refresh_token"])
        assert late.status_code == 401 and late.json()["error"]["code"] == "TOKEN_SUPERSEDED", late.text  # reverted (the chain is not followed through a rotated hop) → TOKEN_REVOKED
        assert (await w.refresh(rot.json()["data"]["refresh_token"])).status_code == 200  # and the session's newest token is untouched
    finally:
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_the_word_is_revoked_not_superseded_for_every_other_end_realdb(kind):
    """only a switch's end is «moved on»: a logout · a password change (the same explicit end without a successor), a switch followed by a logout (the successor is ended too), a rotation, and a switch past the short window"""
    from app.core.config import settings
    engine, w = await _world()
    old_super = settings.auth_refresh_superseded_window_seconds
    old_resolve = settings.auth_refresh_chain_resolve_window_seconds
    try:
        # 1) a plain logout: no successor
        a = await w.login()
        await _end_every_session_like_a_logout(w)
        r = await w.refresh(a["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED"
        # 2) a switch, then the person logs out: the successor is ended too → the old token is plain revoked
        b = await w.login()
        sw = await _switchers(w)[kind](b)
        assert sw.status_code == 200
        await _end_every_session_like_a_logout(w)
        r = await w.refresh(b["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (the successor is not looked at) → TOKEN_SUPERSEDED
        # 3) a switch, then the superseded window closes
        c = await w.login()
        sw = await _switchers(w)[kind](c)
        assert sw.status_code == 200
        settings.auth_refresh_superseded_window_seconds = 0
        r = await w.refresh(c["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (no window) → TOKEN_SUPERSEDED for ever
        settings.auth_refresh_superseded_window_seconds = old_super
        # 4) an ordinary rotation (no switch): the old token, once outside the resolve window, is revoked — a rotation's end is not an explicit end, whatever the windows are
        settings.auth_refresh_chain_resolve_window_seconds = 0
        d = await w.login()
        rot = await w.refresh(d["refresh_token"])
        assert rot.status_code == 200, rot.text
        r = await w.refresh(d["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (the explicit-end test dropped) → TOKEN_SUPERSEDED
        # 6) the successor was rotated once (a refresh), then every other session ended the way a password change / «sign out everywhere» does: the rotated hop keeps its earlier `revoked_at`
        #    but its grace window is closed (`expires_at` = now) — it is NOT «not ended»
        from app.routers.auth import _revoke_other_sessions
        f = await w.login()
        sw = await _switchers(w)[kind](f)
        assert sw.status_code == 200
        rot = await w.refresh(sw.json()["data"]["refresh_token"])
        assert rot.status_code == 200, rot.text
        async with w.Session() as s:
            await _revoke_other_sessions(s, w.user_id, None)
            await s.commit()
        r = await w.refresh(f["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (rotated hop judged by revoked_at < expires_at) → TOKEN_SUPERSEDED
        # 7) the session carried on past the successor (switch, then a refresh) and THEN that newest token is logged out: the end of the chain is dead
        g = await w.login()
        sw = await _switchers(w)[kind](g)
        assert sw.status_code == 200
        rot = await w.refresh(sw.json()["data"]["refresh_token"])
        assert rot.status_code == 200, rot.text
        lo = await w.client.post("/api/v2/auth/logout", json={"refresh_token": rot.json()["data"]["refresh_token"]})
        assert lo.status_code == 200
        r = await w.refresh(g["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (only the first successor is looked at) → TOKEN_SUPERSEDED
        # 8) the successor is revoked (inside its grace window) but points at nothing: no live end to the chain → not «moved on»
        from sqlalchemy import select, update

        from app.core.security import hash_token
        from app.models.user import RefreshToken
        h = await w.login()
        sw = await _switchers(w)[kind](h)
        assert sw.status_code == 200
        async with w.Session() as s:
            await s.execute(update(RefreshToken).where(RefreshToken.token_hash == hash_token(sw.json()["data"]["refresh_token"])).values(revoked_at=datetime.now(timezone.utc), replaced_by=None))
            await s.commit()
        r = await w.refresh(h["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (a dead end counts as alive) → TOKEN_SUPERSEDED
        # 5) a pointer to another person's token is not «moved on» (never written by the app; a damaged row must not read as a live session)
        from sqlalchemy import select, update

        from app.core.security import hash_password, hash_token
        from app.models.user import RefreshToken, User
        e = await w.login()
        sw = await _switchers(w)[kind](e)
        assert sw.status_code == 200
        other = uuid.uuid4()
        async with w.Session() as s:
            s.add(User(id=other, email=f"story4778-other-{other.hex[:8]}@test.com", hashed_password=hash_password(_PASSWORD), is_active=True, email_verified=True))
            await s.commit()
            successor = (await s.execute(select(RefreshToken.replaced_by).where(RefreshToken.token_hash == hash_token(e["refresh_token"])))).scalar_one()
            await s.execute(update(RefreshToken).where(RefreshToken.id == successor).values(user_id=other))
            await s.commit()
        r = await w.refresh(e["refresh_token"])
        assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text  # reverted (the successor's owner is not compared) → TOKEN_SUPERSEDED
    finally:
        settings.auth_refresh_superseded_window_seconds = old_super
        settings.auth_refresh_chain_resolve_window_seconds = old_resolve
        await _close(engine, w)


@pytest.mark.parametrize("kind", ["org", "project"])
async def test_the_all_device_fallback_leaves_no_successor_so_those_tokens_are_revoked_realdb(kind):
    """a caller that does not send its refresh token (an older web pod during a deploy) still ends every token of the person: those sessions are over, not moved on"""
    engine, w = await _world()
    try:
        a, other = await w.login(), await w.login()
        body = {"org_id": str(w.org2)} if kind == "org" else {"project_id": str(w.project1)}
        path = "/api/v2/auth/switch-org" if kind == "org" else "/api/v2/auth/switch-project"
        sw = await w.client.post(path, json=body, headers={"Authorization": f"Bearer {a['access_token']}"})  # no refresh_token in the body
        assert sw.status_code == 200, sw.text
        for token in (a, other):
            r = await w.refresh(token["refresh_token"])
            assert r.status_code == 401 and r.json()["error"]["code"] == "TOKEN_REVOKED", r.text
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
                assert rf.json()["error"]["code"] == "TOKEN_SUPERSEDED", rf.text  # the refresh that lost to a committed switch is «moved on», never plain revoked (the BFF would clear both cookies on that)
                refused += 1
        print(f"\n[4778 race:{kind}] trials={RACE_TRIALS} refresh refused (would clear both cookies)={refused}")
    finally:
        await _close(engine, w)
