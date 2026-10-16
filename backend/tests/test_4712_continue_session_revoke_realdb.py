"""story #4712 (Kadir v2 lens ⑤) — the session «브라우저 이어받기» hands the Mac app is an ordinary refresh-token session, so «sign out
everywhere else» (#4630) ends it like any other, and an ended one cannot fork a new session.

The new web page / POST make the one-time code through the EXISTING internal issue (oauth-handoff) and the app trades it at the
EXISTING consume — no new way to make a session. This file pins the part the lens asked for with a real PG: the pair that comes
out of issue → consume (custom_scheme, the Mac app's mode) is a live `refresh_tokens` row of that person, `logout-others` ends it
(or keeps it, when it is «this» session), and the refresh of an ended one is refused.
"""
from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_CUSTOM_SCHEME_RETURN_URI = "ai.sprintable:/oauth-return"


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


def _setup_handoff(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_oauth_handoff_enabled", True)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)


class _FakeRequest:
    def __init__(self, ip: str = "127.0.0.1"):
        self.client = type("_FakeClient", (), {"host": ip})()
        self.headers: dict[str, str] = {}


async def _seed_user(session):
    from app.core.security import hash_password
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"story4712-{user_id.hex[:8]}@test.com", hashed_password=hash_password("x"),
        is_active=True, email_verified=True, password_set_at=datetime.now(timezone.utc) - timedelta(hours=2),
    ))
    await session.commit()
    return user_id


async def _seed_browser_rt(session, user_id) -> str:
    """the person's ordinary browser session (a live refresh token)"""
    from app.core.security import create_refresh_token, hash_token
    from app.models.user import RefreshToken

    started = int((datetime.now(timezone.utc) - timedelta(minutes=30)).timestamp())
    raw, exp = create_refresh_token(str(user_id), session_started_at=started)
    session.add(RefreshToken(id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw), expires_at=exp, revoked_at=None))
    await session.commit()
    return raw


async def _app_session_via_handoff(Session, user_id) -> str:
    """what the Mac app gets: issue (as the web's [열기] does, custom_scheme) → consume (as the app does, with its verifier)"""
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )
    from app.services.oauth_handoff import pkce_challenge_from_verifier

    verifier = secrets.token_urlsafe(32)
    challenge = pkce_challenge_from_verifier(verifier)
    async with Session() as s:
        issued = await issue_oauth_handoff(
            _FakeRequest(),
            OAuthHandoffIssueRequest(user_id=str(user_id), code_challenge=challenge, callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI),
            authorization=None, db=s,
        )
    async with Session() as s:
        consumed = await consume_oauth_handoff(
            _FakeRequest(),
            OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier, callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI),
            authorization=None, db=s,
        )
    return consumed.refresh_token


async def _row(Session, raw: str):
    from sqlalchemy import select
    from app.core.security import hash_token
    from app.models.user import RefreshToken

    async with Session() as s:
        return (await s.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)))).scalar_one()


@pytest.mark.anyio
async def test_the_app_session_from_the_continue_path_is_a_live_refresh_token_of_that_person(monkeypatch):
    _setup_handoff(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
        app_rt = await _app_session_via_handoff(Session, user_id)
        row = await _row(Session, app_rt)
        assert row.user_id == user_id
        assert row.revoked_at is None
        assert row.expires_at > datetime.now(timezone.utc)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_from_the_browser_ends_the_app_session_and_it_cannot_refresh(monkeypatch):
    from app.main import app

    _setup_handoff(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            browser_rt = await _seed_browser_rt(s, user_id)
        app_rt = await _app_session_via_handoff(Session, user_id)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=int((datetime.now(timezone.utc) - timedelta(minutes=30)).timestamp()))
        try:
            async with _client_for(app) as client:
                resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": browser_rt})
                assert resp.status_code == 200, resp.text
                assert resp.json()["data"] == {"sessions_ended": 1, "kept_this": True}
                forked = await client.post("/api/v2/auth/refresh", json={"refresh_token": app_rt})
                assert forked.status_code in (401, 403), forked.text
                kept = await client.post("/api/v2/auth/refresh", json={"refresh_token": browser_rt})
                assert kept.status_code == 200, kept.text
        finally:
            app.dependency_overrides.clear()

        assert (await _row(Session, app_rt)).revoked_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_logout_others_from_the_app_session_keeps_the_app_and_ends_the_browser(monkeypatch):
    from app.main import app

    _setup_handoff(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            browser_rt = await _seed_browser_rt(s, user_id)
        app_rt = await _app_session_via_handoff(Session, user_id)

        await _setup_db_override(app, Session)
        _override_auth(app, user_id=user_id, session_started_at=int(datetime.now(timezone.utc).timestamp()))
        try:
            async with _client_for(app) as client:
                resp = await client.post("/api/v2/auth/logout-others", json={"refresh_token": app_rt})
                assert resp.status_code == 200, resp.text
                assert resp.json()["data"] == {"sessions_ended": 1, "kept_this": True}
        finally:
            app.dependency_overrides.clear()

        assert (await _row(Session, browser_rt)).revoked_at is not None
        assert (await _row(Session, app_rt)).revoked_at is None
    finally:
        await engine.dispose()
