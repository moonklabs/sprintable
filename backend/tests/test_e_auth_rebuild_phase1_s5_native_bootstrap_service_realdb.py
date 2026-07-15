"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 게이트: issue_bootstrap_code/consume_bootstrap_code
원자성 실증. 산티아고 §9 필수 테스트 중 BE 서비스 레이어 항목 — expired/replayed 거부·병렬
exactly-one·cross-project/device 거부·code_hash만 저장(원문 미저장) 실DB 확인.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"


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


async def _seed_user(session):
    from app.core.security import hash_password
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"authreb-s5-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    return user_id


@pytest.mark.anyio
async def test_issued_code_stores_only_hash_not_plaintext():
    from sqlalchemy import select
    from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
    from app.services.native_bootstrap import issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-1", project_id=PROJECT_ID,
            )

        async with Session() as s:
            row = (await s.execute(
                select(AuthNativeBootstrapCode).where(AuthNativeBootstrapCode.user_id == user_id)
            )).scalar_one()
            assert row.code_hash != raw_code
            # code_hash 컬럼 어디에도 raw_code 문자열이 부분 문자열로도 안 남는지.
            assert raw_code not in row.code_hash
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_succeeds_exactly_once_then_replay_fails():
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-1", project_id=PROJECT_ID,
            )

        async with Session() as s:
            first = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID)
        assert first is not None
        assert first.firebase_uid == "fb-uid-1"

        async with Session() as s:
            replay = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID)
        assert replay is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_consume_exactly_one_wins():
    """산티아고 §9: 동시 2요청 중 정확히 1건만 성공 — TOCTOU 없는 단일 원자적 UPDATE 실증."""
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-concurrent", project_id=PROJECT_ID,
            )

        async def _attempt():
            async with Session() as s:
                return await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID)

        results = await asyncio.gather(_attempt(), _attempt())
        successes = [r for r in results if r is not None]
        assert len(successes) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_expired_code_rejected():
    from sqlalchemy import update
    from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-expired", project_id=PROJECT_ID, ttl_seconds=45,
            )
            # 이미 만료된 것처럼 강제 조작(TTL 45초를 실제로 기다리지 않기 위함).
            await s.execute(
                update(AuthNativeBootstrapCode)
                .where(AuthNativeBootstrapCode.user_id == user_id)
                .values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await s.commit()

        async with Session() as s:
            result = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID)
        assert result is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_project_id_rejected():
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-wrongproj", project_id=PROJECT_ID,
            )

        async with Session() as s:
            result = await consume_bootstrap_code(s, code=raw_code, project_id="different-project")
        assert result is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_device_binding_hash_mismatch_rejected_when_required():
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-device", project_id=PROJECT_ID,
                device_binding_hash="correct-device-hash",
            )

        async with Session() as s:
            wrong = await consume_bootstrap_code(
                s, code=raw_code, project_id=PROJECT_ID, device_binding_hash="wrong-device-hash"
            )
        assert wrong is None

        async with Session() as s:
            missing = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, device_binding_hash=None)
        assert missing is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_device_binding_not_required_when_issued_without_it():
    from app.services.native_bootstrap import consume_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid="fb-uid-nodevice", project_id=PROJECT_ID,
                device_binding_hash=None,
            )

        async with Session() as s:
            result = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, device_binding_hash=None)
        assert result is not None
    finally:
        await engine.dispose()
