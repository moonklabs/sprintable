"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 게이트: POST /api/v2/internal/auth/
native-bootstrap/consume — 서비스-투-서비스 atomic consume+세션쿠키 mint 체인이 실 DB로
정확히 동작하는지 실증. mint_session_cookie_for_uid()의 Google 왕복은 모킹(S5 계약테스트가
그 체인 자체는 이미 검증), 여기선 라우터의 게이팅/consume 위임/응답 형태만 확인.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
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


async def _seed_user_and_code(session, *, device_binding_hash=None):
    from app.core.security import hash_password
    from app.models.user import User
    from app.services.native_bootstrap import issue_bootstrap_code

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"authreb-s5-consume-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()

    raw_code = await issue_bootstrap_code(
        session, user_id=user_id, firebase_uid=f"fb-uid-{user_id.hex[:8]}", project_id=PROJECT_ID,
        device_binding_hash=device_binding_hash,
    )
    return raw_code


def _setup_common(monkeypatch, *, mobile_issue: bool = True):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", mobile_issue)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")


@pytest.mark.anyio
async def test_flag_off_returns_501(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch, mobile_issue=False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="whatever"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_internal_secret_rejected(monkeypatch):
    from app.core.config import settings
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "correct-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="whatever"),
                    authorization="Bearer wrong-secret", db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_code_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="never-issued-code"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_success_returns_minted_cookie(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        assert project_id == PROJECT_ID
        return "minted-native-session-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code = await _seed_user_and_code(s)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert result.session_cookie == "minted-native-session-cookie"
        assert result.expires_in == 5 * 24 * 60 * 60
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_replay_after_success_rejected(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "minted-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code = await _seed_user_and_code(s)

        async with Session() as s:
            first = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert first.session_cookie == "minted-cookie"

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mint_failure_returns_502(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return None
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code = await _seed_user_and_code(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 502
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_device_binding_mismatch_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code = await _seed_user_and_code(s, device_binding_hash="correct-hash")

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code, device_binding_hash="wrong-hash"),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()
