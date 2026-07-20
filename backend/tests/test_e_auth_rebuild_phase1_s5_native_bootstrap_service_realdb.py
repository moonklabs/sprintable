"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5)+story cbd578d4(C4·§7.5) 게이트:
issue_bootstrap_code/consume_bootstrap_code 원자성 실증 — expired/replayed 거부·병렬
exactly-one·cross-project/installation 거부·code_hash만 저장(원문 미저장) 실DB 확인.

⚠️C4: `device_binding_hash`(문자열 비교) 완전 삭제 — `installation_id` 바인딩으로 대체.
raw code는 이제 `generate_bootstrap_code()`(순수 함수)로 먼저 만들고 `issue_bootstrap_code()`
에 `code_hash`로 전달한다(redeem 챌린지가 같은 hash를 먼저 바인딩해야 하는 순서 제약,
§7.5)."""
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


async def _seed_installation(session, *, user_id):
    from app.models.device_installation import DeviceInstallation

    installation = DeviceInstallation(
        id=uuid.uuid4(), user_id=user_id, firebase_uid="fb-uid-1", project_id=PROJECT_ID,
        environment="production", platform="ios", app_id="com.sprintable.app", key_version=1,
        public_key_fingerprint=f"fp-{uuid.uuid4().hex[:12]}", public_key_der=b"\x00\x01\x02",
        attestation_type="app_attest", status="active", attested_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    session.add(installation)
    await session.commit()
    return installation.id


@pytest.mark.anyio
async def test_issued_code_stores_only_hash_not_plaintext():
    from sqlalchemy import select
    from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
    from app.services.native_bootstrap import generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-1", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1,
            )

        async with Session() as s:
            row = (await s.execute(
                select(AuthNativeBootstrapCode).where(AuthNativeBootstrapCode.user_id == user_id)
            )).scalar_one()
            assert row.code_hash != raw_code
            assert raw_code not in row.code_hash
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_succeeds_exactly_once_then_replay_fails():
    from app.services.native_bootstrap import consume_bootstrap_code, generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-1", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1,
            )

        async with Session() as s:
            first = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, installation_id=installation_id)
        assert first is not None
        assert first.firebase_uid == "fb-uid-1"

        async with Session() as s:
            replay = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, installation_id=installation_id)
        assert replay is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_consume_exactly_one_wins():
    """산티아고 §9: 동시 2요청 중 정확히 1건만 성공 — TOCTOU 없는 단일 원자적 UPDATE 실증."""
    from app.services.native_bootstrap import consume_bootstrap_code, generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-concurrent", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1,
            )

        async def _attempt():
            async with Session() as s:
                return await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, installation_id=installation_id)

        results = await asyncio.gather(_attempt(), _attempt())
        successes = [r for r in results if r is not None]
        assert len(successes) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_expired_code_rejected():
    from sqlalchemy import update
    from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
    from app.services.native_bootstrap import consume_bootstrap_code, generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-expired", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1, ttl_seconds=45,
            )
            # 이미 만료된 것처럼 강제 조작(TTL 45초를 실제로 기다리지 않기 위함).
            await s.execute(
                update(AuthNativeBootstrapCode)
                .where(AuthNativeBootstrapCode.user_id == user_id)
                .values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
            )
            await s.commit()

        async with Session() as s:
            result = await consume_bootstrap_code(s, code=raw_code, project_id=PROJECT_ID, installation_id=installation_id)
        assert result is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_project_id_rejected():
    from app.services.native_bootstrap import consume_bootstrap_code, generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-wrongproj", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1,
            )

        async with Session() as s:
            result = await consume_bootstrap_code(
                s, code=raw_code, project_id="different-project", installation_id=installation_id
            )
        assert result is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_installation_id_rejected():
    """C4: 코드는 발급 시 바인딩된 installation으로만 소비 가능 — 다른(공격자) installation
    id로는 원자 UPDATE가 0행."""
    from app.services.native_bootstrap import consume_bootstrap_code, generate_bootstrap_code, issue_bootstrap_code

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            installation_id = await _seed_installation(s, user_id=user_id)
            other_installation_id = await _seed_installation(s, user_id=user_id)
            raw_code, code_hash = generate_bootstrap_code()
            await issue_bootstrap_code(
                s, code_hash=code_hash, user_id=user_id, firebase_uid="fb-uid-device", project_id=PROJECT_ID,
                installation_id=installation_id, key_version=1,
            )

        async with Session() as s:
            wrong = await consume_bootstrap_code(
                s, code=raw_code, project_id=PROJECT_ID, installation_id=other_installation_id
            )
        assert wrong is None

        async with Session() as s:
            correct = await consume_bootstrap_code(
                s, code=raw_code, project_id=PROJECT_ID, installation_id=installation_id
            )
        assert correct is not None
    finally:
        await engine.dispose()
