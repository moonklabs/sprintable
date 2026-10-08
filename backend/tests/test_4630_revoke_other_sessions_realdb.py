"""story #4630 ([보안 · 계정], PO 2026-10-08 · 유나 발견) — a password change / reset and «sign out everywhere else» end the
other sessions now, keep this one, and touch nothing but refresh tokens.

What was there (develop, read 09:15Z): `change_password` · `reset_password` only set `password_set_at`. #3649's check then
stops every session at its next refresh — this one too (the person who changed it was signed out) — and no token row was
revoked. There was no way to end the other sessions without changing the password.

`_revoke_other_sessions` (auth.py): ① live tokens of the person but this session's → explicit revoke; ② tokens revoked by a
rotation but still inside the refresh grace window (§2449) → window closed, so a device's previous token cannot fork a new
session after its live one was revoked. This session's own predecessor keeps its window (the browser's own race).
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

OLD_PW = "Old-pass-4630"
NEW_PW = "New-pass-4630!"


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


async def _setup_db_override(app, Session):
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    override_db_and_read(app, _db)


def _override_auth(app, *, user_id, session_started_at):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"session_started_at": session_started_at})

    app.dependency_overrides[get_current_user] = _auth


async def _seed_user(session):
    from app.core.security import hash_password
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"story4630-{user_id.hex[:8]}@test.com", hashed_password=hash_password(OLD_PW),
        is_active=True, email_verified=True, password_set_at=datetime.now(timezone.utc) - timedelta(hours=2),
    ))
    await session.commit()
    return user_id


def _started() -> int:
    return int((datetime.now(timezone.utc) - timedelta(minutes=30)).timestamp())


async def _seed_rt(session, user_id, *, started: int) -> str:
    from app.core.security import create_refresh_token, hash_token
    from app.models.user import RefreshToken

    raw, exp = create_refresh_token(str(user_id), session_started_at=started)
    session.add(RefreshToken(id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw), expires_at=exp, revoked_at=None))
    await session.commit()
    return raw


async def _refresh(client, raw: str):
    return await client.post("/api/v2/auth/refresh", json={"refresh_token": raw})


async def _rows(Session, user_id):
    from sqlalchemy import select
    from app.models.user import RefreshToken

    async with Session() as s:
        return (await s.execute(select(RefreshToken).where(RefreshToken.user_id == user_id))).scalars().all()


# ── AC1 change-password: others end now · this session kept ─────────────────────────


@pytest.mark.anyio
async def test_change_password_ends_other_sessions_and_keeps_this_one():
    """RED on develop: no tokens came back and this session's refresh → 401 SESSION_INVALIDATED (#3649 caught it too)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_rt = await _seed_rt(s, user_id, started=started)
            other_rt = await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/auth/change-password", json={
                "current_password": OLD_PW, "new_password": NEW_PW, "refresh_token": this_rt,
            })
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["kept_this"] is True and data["sessions_ended"] == 1, data
            assert (await _refresh(client, data["refresh_token"])).status_code == 200  # this session goes on
            other = await _refresh(client, other_rt)
            assert other.status_code == 401, other.text
            assert other.json()["error"]["code"] == "TOKEN_REVOKED"  # revoked now, not only stale at its next refresh
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_change_password_without_this_sessions_token_ends_every_session():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            await _seed_rt(s, user_id, started=started)
            await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/auth/change-password", json={"current_password": OLD_PW, "new_password": NEW_PW})
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["kept_this"] is False and data["sessions_ended"] == 2 and "refresh_token" not in data, data
            assert all(r.revoked_at is not None for r in await _rows(Session, user_id))
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_change_password_wrong_current_password_ends_nothing():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_rt = await _seed_rt(s, user_id, started=started)
            other_rt = await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.patch("/api/v2/auth/change-password", json={
                "current_password": "Wrong-pass-1", "new_password": NEW_PW, "refresh_token": this_rt,
            })
            assert resp.status_code == 400, resp.text
            assert (await _refresh(client, other_rt)).status_code == 200
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC1 reset-password: signed out — every session ends, chains too ──────────────────


@pytest.mark.anyio
async def test_reset_password_ends_every_session_and_closes_the_rotation_window():
    """RED on develop: the token rows stayed live (only #3649's stale check stood in the way, at the next refresh)."""
    from app.main import app
    from app.core.security import create_password_reset_token

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            live_rt = await _seed_rt(s, user_id, started=started)
            rotated_rt = await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            assert (await _refresh(client, rotated_rt)).status_code == 200  # a device rotated a moment ago (window open)
            async with Session() as s:
                from app.models.user import User
                user = await s.get(User, user_id)
                token = create_password_reset_token(str(user_id), user.hashed_password)
            resp = await client.post("/api/v2/auth/reset-password", json={"token": token, "new_password": NEW_PW})
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["sessions_ended"] == 2  # the live one + the rotated device's new one
            now = datetime.now(timezone.utc) + timedelta(seconds=5)
            rows = await _rows(Session, user_id)
            assert rows and all(r.revoked_at is not None and r.expires_at <= now for r in rows), [
                (r.revoked_at, r.expires_at) for r in rows
            ]
            assert (await _refresh(client, live_rt)).status_code == 401
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC2 logout-others ─────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_logout_others_ends_other_devices_through_the_end_of_their_chain_and_keeps_this_one():
    """No password change here, so #3649's check does not help: a device whose token was rotated a moment ago still holds
    the previous one, which the refresh grace window (§2449) would let fork a new session. RED with pass ② removed."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_rt = await _seed_rt(s, user_id, started=started)
            other_rt = await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            rotated = await _refresh(client, other_rt)
            assert rotated.status_code == 200
            other_next = rotated.json()["data"]["refresh_token"]

            resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": this_rt})
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"] == {"sessions_ended": 1, "kept_this": True}

            assert (await _refresh(client, other_next)).status_code == 401  # the device's live token
            assert (await _refresh(client, other_rt)).status_code == 401  # its previous one — the chain's end
            assert (await _refresh(client, this_rt)).status_code == 200  # this browser
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_counts_only_live_sign_ins_not_expired_rows():
    """«다른 로그인 {n}개» (Yuna · Didi 09:23Z): a row expired without ever being revoked is a sign-in already over — not counted."""
    from app.main import app
    from app.core.security import hash_token
    from app.models.user import RefreshToken

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_rt = await _seed_rt(s, user_id, started=started)
            await _seed_rt(s, user_id, started=started)  # one other live sign-in
            s.add(RefreshToken(id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(f"expired-{uuid.uuid4()}"),
                               expires_at=datetime.now(timezone.utc) - timedelta(days=1), revoked_at=None))
            await s.commit()

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": this_rt})
            assert resp.json()["data"] == {"sessions_ended": 1, "kept_this": True}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_keeps_this_sessions_own_rotation_race():
    """This browser rotated a moment ago and a parallel request of it still holds the previous token: that one keeps its
    grace window (it is this session, not another device)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_old = await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            this_now = (await _refresh(client, this_old)).json()["data"]["refresh_token"]
            resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": this_now})
            assert resp.json()["data"] == {"sessions_ended": 0, "kept_this": True}
            assert (await _refresh(client, this_old)).status_code == 200
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_with_another_persons_token_keeps_nothing_and_never_touches_theirs():
    """AC5: «this session» is only ever this person's live token — someone else's token neither stays nor ends."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            me = await _seed_user(s)
            mine = await _seed_rt(s, me, started=started)
            them = await _seed_user(s)
            theirs = await _seed_rt(s, them, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=me, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": theirs})
            assert resp.json()["data"] == {"sessions_ended": 1, "kept_this": False}
            assert (await _refresh(client, theirs)).status_code == 200
            assert (await _refresh(client, mine)).status_code == 401
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_without_a_token_ends_every_session():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            a = await _seed_rt(s, user_id, started=started)
            await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/logout-others", json={})
            assert resp.json()["data"] == {"sessions_ended": 2, "kept_this": False}
            assert (await _refresh(client, a)).status_code == 401
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_from_a_session_older_than_the_password_401():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            kept = await _seed_rt(s, user_id, started=_started())

        await _setup_db_override(app, Session)
        stale = int((datetime.now(timezone.utc) - timedelta(hours=3)).timestamp())  # before password_set_at (-2 h)
        _override_auth(app, user_id=user_id, session_started_at=stale)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": kept})
            assert resp.status_code == 401 and resp.json()["error"]["code"] == "SESSION_INVALIDATED", resp.text
            assert (await _refresh(client, kept)).status_code == 200  # nothing ended
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC4 only refresh tokens: API keys · a desktop setup's device token · phone keys are other tables ──


@pytest.mark.anyio
async def test_the_three_paths_write_only_users_and_refresh_tokens():
    """Every write the three paths make, read off the wire: `users` (the password) and `refresh_tokens`. Agents run on API
    keys (agent_api_keys) and their setup's device token (desktop_device_tokens); a paired phone's key is remote_devices
    — none of those is written, so desktop agents keep running and a phone signed in again keeps its pairing."""
    from sqlalchemy import event
    from app.main import app
    from app.core.security import create_password_reset_token

    engine, Session = await _session_factory()
    written: set[str] = set()

    def _on_execute(conn, cursor, statement, parameters, context, executemany):  # noqa: ARG001
        words = statement.lstrip().split(None, 3)
        verb = words[0].upper() if words else ""
        if verb == "UPDATE" and len(words) > 1:
            written.add(words[1].strip('"'))
        elif verb in ("INSERT", "DELETE") and len(words) > 2:
            written.add(words[2].strip('"'))

    try:
        started = _started()
        async with Session() as s:
            user_id = await _seed_user(s)
            this_rt = await _seed_rt(s, user_id, started=started)
            await _seed_rt(s, user_id, started=started)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=started)
        client = _client_for(app)
        event.listen(engine.sync_engine, "before_cursor_execute", _on_execute)
        try:
            r1 = await client.post("/api/v2/auth/logout-others", json={"refresh_token": this_rt})
            assert r1.status_code == 200, r1.text
            r2 = await client.patch("/api/v2/auth/change-password", json={
                "current_password": OLD_PW, "new_password": NEW_PW, "refresh_token": this_rt,
            })
            assert r2.status_code == 200, r2.text
            async with Session() as s:
                from app.models.user import User
                user = await s.get(User, user_id)
                token = create_password_reset_token(str(user_id), user.hashed_password)
            r3 = await client.post("/api/v2/auth/reset-password", json={"token": token, "new_password": "Third-pass-4630!"})
            assert r3.status_code == 200, r3.text
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _on_execute)
            await client.aclose()
        assert "refresh_tokens" in written, written
        assert written <= {"users", "refresh_tokens"}, written
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_the_copy_says_within_an_hour_because_access_tokens_live_60_minutes():
    """Yuna («4630» ②): the web copy promises «길어야 1시간 안에 로그아웃» (settings.otherSessions* · resetPassword.done) — a
    revoked sign-in still holds its access token until it expires. If this number changes, change those lines with it."""
    from app.core.security import ACCESS_TOKEN_EXPIRE_MINUTES

    assert ACCESS_TOKEN_EXPIRE_MINUTES <= 60, "the web copy says «within an hour» — change apps/web/messages with this value"
