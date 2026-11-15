"""story 4915 AC6 — the per-person refresh count is made only for a token that is still ALIVE (real PG).

codex 01a1d30a: a unit test that answers the liveness read with a preset boolean cannot tell whether the SQL still asks the right question. This one asks a real database, row by row:

| the token row                                                         | counted? |
| live (not ended, not expired)                                         | yes |
| ended by a rotation a moment ago (inside the straggler window)        | yes — the holder of such a token is the person's own live session |
| ended by a rotation long ago (outside the window), expiry in the future | NO — an old copy somebody kept must not burn the person's count |
| expired                                                               | NO |
| ended explicitly (logout · password change: `expires_at` lowered with `revoked_at`) | NO |
| no such row                                                           | NO |
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

import app.main  # noqa: E402,F401  (same reason as test_e5225c0a: fix the logging configuration order before any caplog test)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _fresh_person_counts(monkeypatch):
    from app.core import rate_limit
    from app.core.rate_limit import reset_person_limits

    monkeypatch.setattr(rate_limit.limiter, "enabled", True)   # pytest switches the shared limiter (and with it the person count) off by default; this file is about the count
    reset_person_limits()
    yield
    reset_person_limits()


_SEEDED_USER_IDS: list[uuid.UUID] = []


@pytest.fixture(autouse=True)
async def _remove_what_the_test_seeded():
    """a shared CI database must not keep the users and refresh-token rows this file commits (codex 01a1d318)"""
    _SEEDED_USER_IDS.clear()
    yield
    if _SEEDED_USER_IDS:
        from sqlalchemy import delete
        from sqlalchemy.ext.asyncio import create_async_engine

        from app.models.user import RefreshToken, User

        engine = create_async_engine(_async_url())
        try:
            async with engine.begin() as conn:
                await conn.execute(delete(RefreshToken).where(RefreshToken.user_id.in_(_SEEDED_USER_IDS)))
                await conn.execute(delete(User).where(User.id.in_(_SEEDED_USER_IDS)))
        finally:
            await engine.dispose()
        _SEEDED_USER_IDS.clear()


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


async def _seed(session, *, expires_in: timedelta, revoked_ago: timedelta | None):
    """one user and one refresh-token row; returns (user_id, raw token, token hash)"""
    from app.core.security import create_refresh_token, hash_password, hash_token
    from app.models.user import RefreshToken, User

    user_id = uuid.uuid4()
    _SEEDED_USER_IDS.append(user_id)
    session.add(User(id=user_id, email=f"4915-ac6-{user_id.hex[:8]}@test.com", hashed_password=hash_password("x"), is_active=True, email_verified=True))
    await session.commit()
    raw, _exp = create_refresh_token(str(user_id))
    now = datetime.now(timezone.utc)
    session.add(RefreshToken(
        id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw),
        expires_at=now + expires_in, revoked_at=(now - revoked_ago) if revoked_ago is not None else None,
    ))
    await session.commit()
    return user_id, raw, hash_token(raw)


async def _first_limited_call(Session, user_id, token_hash, calls: int = 65) -> int | None:
    """the 1-based number of the first call answered with a 429, or None if none of `calls` was.

    The limit is a real 60-per-minute moving window, so the whole run must fit inside one window: if the machine is so slow that it does not, the run cannot judge anything and is SKIPPED —
    never reported as a pass that a broken helper would also get (the calls are spread over several windows) or as a false failure."""
    import time

    from app.routers.auth import _refresh_person_limit_answer

    started = time.monotonic()
    for n in range(1, calls + 1):
        async with Session() as s:
            answer = await _refresh_person_limit_answer(s, user_id, token_hash)
        if answer is not None:
            assert answer.status_code == 429
            return n
        if time.monotonic() - started > 40:
            pytest.skip("too slow to judge a 60-per-minute window (the calls would span more than one window)")
    return None


def _window() -> int:
    from app.core.config import settings

    return int(settings.auth_refresh_chain_resolve_window_seconds)   # the straggler window the rotation itself uses (default 180 s)


@pytest.mark.anyio
@pytest.mark.parametrize("case, expires_in, revoked_ago, counted", [
    ("live", timedelta(days=30), None, True),
    ("rotated_a_moment_ago_inside_the_window", timedelta(days=30), "inside", True),
    ("rotated_long_ago_outside_the_window", timedelta(days=30), "outside", False),
    ("expired", timedelta(seconds=-60), None, False),
    ("ended_explicitly_expiry_lowered_with_the_revoke", timedelta(seconds=-5), timedelta(seconds=5), False),
])
async def test_only_a_token_that_is_still_alive_is_counted_against_the_person(case, expires_in, revoked_ago, counted):
    engine, Session = await _session_factory()
    try:
        revoked_ago = {"inside": timedelta(seconds=max(1, _window() // 4)), "outside": timedelta(seconds=_window() * 4 + 3600)}.get(revoked_ago, revoked_ago)
        async with Session() as s:
            user_id, _raw, token_hash = await _seed(s, expires_in=expires_in, revoked_ago=revoked_ago)
        first = await _first_limited_call(Session, user_id, token_hash)
        assert first == (61 if counted else None), f"{case}: first 429 at call {first}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_token_whose_row_belongs_to_another_person_is_not_counted_against_the_signed_sub():
    """Qadir (a): the signed `sub` and the row's owner must agree, or a token could burn a third person's count"""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _owner, _raw, token_hash = await _seed(s, expires_in=timedelta(days=30), revoked_ago=None)
        stranger = uuid.uuid4()
        assert await _first_limited_call(Session, stranger, token_hash) is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_token_with_no_row_is_not_counted():
    engine, Session = await _session_factory()
    try:
        assert await _first_limited_call(Session, uuid.uuid4(), "no-such-hash") is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_old_copies_of_a_persons_tokens_cannot_use_up_the_count_of_their_live_token():
    """the attack the unit test could not show: the same person, one long-rotated copy and one live token; hammering the old copy leaves the live token's sixty intact"""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, _raw_old, hash_old = await _seed(s, expires_in=timedelta(days=30), revoked_ago=timedelta(seconds=_window() * 4 + 3600))
        from app.core.security import create_refresh_token, hash_token
        from app.models.user import RefreshToken

        live_raw, exp = create_refresh_token(str(user_id))
        async with Session() as s:
            s.add(RefreshToken(id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(live_raw), expires_at=exp, revoked_at=None))
            await s.commit()
        assert await _first_limited_call(Session, user_id, hash_old, calls=65) is None
        assert await _first_limited_call(Session, user_id, hash_token(live_raw)) == 61
    finally:
        await engine.dispose()
