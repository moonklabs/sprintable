"""story 4776 — AC1: does an overlapping refresh (the onboarding's four direct `refreshAuthTokens()` callers, or one of them with `fetchWithAuth`'s 401 renewal) log the person out?

The web page can put several `/api/auth/refresh` calls in flight with the SAME refresh cookie (`finishToHome` · the refresh after the organization is made · `connect-step` · `advanced-connect` call
`refreshAuthTokens()` directly, outside the page's single flight `refreshSessionOnce`). Each carries the cookie it had when it left; each response sets the cookie again, so the browser ends up
holding the token of whichever response was applied LAST. The person stays signed in only if EVERY token a response can hold is itself still a living refresh token.

What the server does with the same token twice (story e5225c0a · cd10e123 · 2449): one request wins the atomic rotation; a loser inside `auth_refresh_chain_resolve_window_seconds` (180 s) is a race loser,
not a replay, and gets an independent forked rotation with 200 (`test_e5225c0a_refresh_atomic_realdb.py` proves two). This file pins the part that decides the question: with FIVE overlapping requests every
answer is 200, no two share a token, and EACH returned token can renew once more — whichever Set-Cookie lands last keeps the session. The only thing between an overlap and a forced logout is that window
(a refresh with no window answers 401 and the BFF route clears both cookies): the last test narrows the window to zero and shows the loss.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real PG (PARITY/ALEMBIC_DATABASE_URL) needed"),
]

import app.main  # noqa: E402,F401  (pulled first so logging setup runs before any caplog use — same as the e5225c0a file)

OVERLAP = 5  # the four direct callers + one fetchWithAuth 401 renewal


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed_user_with_refresh_token(session) -> str:
    from app.core.security import create_refresh_token, hash_password, hash_token
    from app.models.user import RefreshToken, User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"4776-{user_id.hex[:8]}@test.com", hashed_password=hash_password("x"), is_active=True, email_verified=True))
    await session.commit()
    raw_refresh, exp = create_refresh_token(str(user_id))
    session.add(RefreshToken(id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw_refresh), expires_at=exp, revoked_at=None))
    await session.commit()
    return raw_refresh


async def _setup_app(app, Session):
    from tests.conftest import override_db_and_read  # story 2451: get_db is overridden only through this helper (it also covers get_read_db)

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)


async def _run_overlap(window_seconds: int | None = None):
    """OVERLAP refreshes with the same token at once, then one more refresh with EACH token that came back (the cookie a browser may end up holding)."""
    from app.core.config import settings
    from app.main import app

    engine, Session = await _session_factory()
    old_window = settings.auth_refresh_chain_resolve_window_seconds
    try:
        async with Session() as s:
            token = await _seed_user_with_refresh_token(s)
        await _setup_app(app, Session)
        if window_seconds is not None:
            settings.auth_refresh_chain_resolve_window_seconds = window_seconds
        client = _client_for(app)
        try:
            overlapped = await asyncio.gather(*[client.post("/api/v2/auth/refresh", json={"refresh_token": token}) for _ in range(OVERLAP)])
            statuses = [r.status_code for r in overlapped]
            returned = [r.json()["data"]["refresh_token"] for r in overlapped if r.status_code == 200]
            followups = []
            for rt in returned:  # each token a response can leave in the cookie must itself renew
                r = await client.post("/api/v2/auth/refresh", json={"refresh_token": rt})
                followups.append(r.status_code)
            return statuses, returned, followups
        finally:
            await client.aclose()
    finally:
        settings.auth_refresh_chain_resolve_window_seconds = old_window
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_overlapping_refreshes_with_one_token_leave_every_cookie_alive_realdb():
    statuses, returned, followups = await _run_overlap()
    assert statuses == [200] * OVERLAP, f"an overlapping refresh was refused — the BFF route would clear both cookies: {statuses}"
    assert len(set(returned)) == OVERLAP, "two overlapping answers share one refresh token — one session mistaken for another"
    assert followups == [200] * OVERLAP, f"a token a response can leave in the cookie cannot renew again — whichever Set-Cookie lands last would log the person out: {followups}"


@pytest.mark.anyio
async def test_without_the_resolve_window_the_overlap_logs_the_person_out_realdb():
    """The only protection is the window: with none, every loser of the atomic rotation is a replay (401) — what the four direct callers rely on today."""
    statuses, _returned, _followups = await _run_overlap(window_seconds=0)
    assert statuses.count(200) == 1, f"exactly one request wins the atomic rotation: {statuses}"
    assert statuses.count(401) == OVERLAP - 1, f"the losers are replays when the window is 0: {statuses}"
