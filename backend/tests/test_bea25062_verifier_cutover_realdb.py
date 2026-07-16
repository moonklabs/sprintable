"""story bea25062(E-AUTH-REBUILD auth_valid_after 코어 인프라) 게이트: 3개(+SSE) verifier가
동일 cutover epoch 기준으로 정확히 동작하는지 실증. §17d-1 4요소 중 ①(전 verifier 강제)을
직접 검증 — auth_valid_after=NULL(기본)이면 무영향, 설정되면 그 이전 자격증명을 거부.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt as jose_jwt

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
KID = "test-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _reset_caches_and_dispose():
    from app.services import auth_cutover as ac
    from app.services import firebase_verifier as fv
    fv._reset_key_cache_for_tests()
    ac._reset_cutover_existence_cache_for_tests()
    yield
    fv._reset_key_cache_for_tests()
    ac._reset_cutover_existence_cache_for_tests()
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


def _make_self_signed_cert() -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as d:
        key_path = Path(d) / "key.pem"
        cert_path = Path(d) / "cert.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key_path),
             "-out", str(cert_path), "-days", "1", "-nodes", "-subj", "/CN=test"],
            check=True, capture_output=True,
        )
        return key_path.read_text(), cert_path.read_text()


def _make_session_cookie(key_pem: str, sub: str, auth_time: int) -> str:
    now = int(time.time())
    claims = {
        "sub": sub, "email": "user@test.com", "auth_time": auth_time, "iat": now, "exp": now + 3600,
        "iss": f"https://session.firebase.google.com/{PROJECT_ID}", "aud": PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": KID})


async def _seed_legacy_user(session):
    from app.core.security import hash_password
    from app.models.user import User
    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"cutover-legacy-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    return user_id


async def _seed_firebase_user(session):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity
    from app.models.user import User
    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"cutover-fb-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://session.firebase.google.com/{PROJECT_ID}", subject=firebase_uid,
        provider_id="password",
    ))
    await session.commit()
    return user_id, firebase_uid


async def _set_auth_valid_after(session, user_id, epoch):
    from app.models.auth_identity import AuthMigration
    row = await session.get(AuthMigration, user_id)
    if row is None:
        session.add(AuthMigration(user_id=user_id, state="firebase", auth_valid_after=epoch))
    else:
        row.auth_valid_after = epoch
    await session.commit()


# ─── legacy(HS256) get_current_user ────────────────────────────────────────

@pytest.mark.anyio
async def test_legacy_token_rejected_when_issued_before_cutover(monkeypatch):
    from app.core.security import create_access_token
    from app.dependencies.auth import get_current_user

    engine, Session = await _session_factory()
    # check_any_cutover_epoch_exists()는 app.core.database.async_session_factory를 함수 내부
    # 지역 import로 매번 새로 참조한다 — 소스 모듈 쪽을 패치해야 이 테스트 DB를 실제로 본다
    # (app.dependencies.auth 쪽 바인딩과는 별개 지점 — 소스 vs 소비 모듈 패치 구분 주의).
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id = await _seed_legacy_user(s)

        token = create_access_token(str(user_id))
        cutover = datetime.now(timezone.utc) + timedelta(hours=1)  # 토큰 발급보다 미래 = 토큰이 cutover 이전
        async with Session() as s:
            await _set_auth_valid_after(s, user_id, cutover)

        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_legacy_token_accepted_when_issued_after_cutover(monkeypatch):
    from app.core.security import create_access_token
    from app.dependencies.auth import get_current_user

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id = await _seed_legacy_user(s)
            cutover = datetime.now(timezone.utc) - timedelta(hours=1)  # 과거 cutover — 지금 발급 토큰은 그 이후
            await _set_auth_valid_after(s, user_id, cutover)

        token = create_access_token(str(user_id))
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
        assert auth.user_id == str(user_id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_legacy_token_unaffected_when_no_migration_row(monkeypatch):
    """auth_valid_after 컬럼 신설 전과 100% 동일 동작 — 대부분의 현재 사용자는 행 자체가 없다."""
    from app.core.security import create_access_token
    from app.dependencies.auth import get_current_user

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id = await _seed_legacy_user(s)

        token = create_access_token(str(user_id))
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
        assert auth.user_id == str(user_id)
    finally:
        await engine.dispose()


# ─── Firebase(RS256) _resolve_firebase_session (get_current_user 경유) ────

@pytest.mark.anyio
async def test_firebase_session_rejected_when_auth_time_before_cutover(monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from app.services import firebase_verifier as fv

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_firebase_user(s)
            cutover = datetime.now(timezone.utc) + timedelta(hours=1)
            await _set_auth_valid_after(s, user_id, cutover)

        auth_time = int(time.time())
        cookie = _make_session_cookie(key_pem, firebase_uid, auth_time)
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_firebase_session_accepted_when_auth_time_after_cutover(monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from app.services import firebase_verifier as fv

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_firebase_user(s)
            cutover = datetime.now(timezone.utc) - timedelta(hours=1)
            await _set_auth_valid_after(s, user_id, cutover)

        auth_time = int(time.time())
        cookie = _make_session_cookie(key_pem, firebase_uid, auth_time)
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)
        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
        assert auth.user_id == str(user_id)
    finally:
        await engine.dispose()


# ─── SSE streaming legacy 경로 ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_sse_streaming_legacy_rejected_when_before_cutover(monkeypatch):
    from app.core.security import create_access_token
    import app.dependencies.auth as auth_module

    engine, Session = await _session_factory()
    monkeypatch.setattr(auth_module, "async_session_factory", Session)
    monkeypatch.setattr("app.core.database.async_session_factory", Session)
    try:
        async with Session() as s:
            user_id = await _seed_legacy_user(s)
            cutover = datetime.now(timezone.utc) + timedelta(hours=1)
            await _set_auth_valid_after(s, user_id, cutover)

        token = create_access_token(str(user_id))
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        with pytest.raises(HTTPException) as exc_info:
            await auth_module.get_current_user_streaming(credentials=credentials, x_agent_api_key=None)
        assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()
