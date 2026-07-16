"""story bea25062(E-AUTH-REBUILD auth_valid_after 코어 인프라·doc §17d-1) 계약 테스트:
is_before_cutover() 순수함수+get_auth_valid_after()/revoke_user_sessions() realdb.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark_realdb = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_is_before_cutover_none_epoch_always_false():
    from app.services.auth_cutover import is_before_cutover
    now = datetime.now(timezone.utc)
    assert is_before_cutover(None, now) is False


def test_is_before_cutover_reference_before_epoch_true():
    from app.services.auth_cutover import is_before_cutover
    epoch = datetime.now(timezone.utc)
    before = epoch - timedelta(seconds=1)
    assert is_before_cutover(epoch, before) is True


def test_is_before_cutover_reference_equal_epoch_true():
    """§17d-1: iat/auth_time <= auth_valid_after면 거부(동일 시각 포함)."""
    from app.services.auth_cutover import is_before_cutover
    epoch = datetime.now(timezone.utc)
    assert is_before_cutover(epoch, epoch) is True


def test_is_before_cutover_reference_after_epoch_false():
    from app.services.auth_cutover import is_before_cutover
    epoch = datetime.now(timezone.utc)
    after = epoch + timedelta(seconds=1)
    assert is_before_cutover(epoch, after) is False


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_user_with_refresh_tokens(session, *, n_tokens: int = 2):
    from app.core.security import hash_password
    from app.models.user import RefreshToken, User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"cutover-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()

    now = datetime.now(timezone.utc)
    for i in range(n_tokens):
        session.add(RefreshToken(
            id=uuid.uuid4(), user_id=user_id, token_hash=f"hash-{user_id.hex[:8]}-{i}",
            expires_at=now + timedelta(days=30),
        ))
    await session.commit()
    return user_id


@pytestmark_realdb
@pytest.mark.anyio
async def test_get_auth_valid_after_none_when_no_migration_row():
    from app.services.auth_cutover import get_auth_valid_after

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            result = await get_auth_valid_after(s, uuid.uuid4())
        assert result is None
    finally:
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_revoke_user_sessions_creates_migration_row_and_revokes_refresh_tokens(monkeypatch):
    from sqlalchemy import select
    from app.models.auth_identity import AuthMigration
    from app.models.user import RefreshToken
    from app.services.auth_cutover import get_auth_valid_after, revoke_user_sessions

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_refresh_tokens(s, n_tokens=3)

        async with Session() as s:
            epoch = await revoke_user_sessions(s, user_id, firebase_uid=None)
        assert epoch is not None

        async with Session() as s:
            stored = await get_auth_valid_after(s, user_id)
            assert stored is not None
            assert abs((stored - epoch).total_seconds()) < 1

            live_count = (await s.execute(
                select(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            )).scalars().all()
            assert len(live_count) == 0

            revoked_count = (await s.execute(
                select(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_not(None))
            )).scalars().all()
            assert len(revoked_count) == 3

            migration_row = await s.get(AuthMigration, user_id)
            assert migration_row is not None
    finally:
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_revoke_user_sessions_updates_existing_migration_row():
    from app.models.auth_identity import AuthMigration
    from app.services.auth_cutover import revoke_user_sessions

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_refresh_tokens(s, n_tokens=0)
            s.add(AuthMigration(user_id=user_id, state="firebase"))
            await s.commit()

        async with Session() as s:
            epoch = await revoke_user_sessions(s, user_id, firebase_uid=None)

        async with Session() as s:
            migration_row = await s.get(AuthMigration, user_id)
            assert migration_row.state == "firebase"  # revoke가 state를 안 건드림
            assert migration_row.auth_valid_after is not None
            assert abs((migration_row.auth_valid_after - epoch).total_seconds()) < 1
    finally:
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_revoke_user_sessions_local_commit_survives_firebase_failure(monkeypatch):
    """§17d-1: Firebase revoke 실패해도 로컬 auth_valid_after+RT revoke는 이미 커밋됨(순서 보장)."""
    from app.services.auth_cutover import get_auth_valid_after, revoke_user_sessions

    async def fake_revoke_firebase(firebase_uid, project_id):
        raise RuntimeError("simulated Firebase outage")
    monkeypatch.setattr(
        "app.services.firebase_session_mint.revoke_firebase_refresh_tokens", fake_revoke_firebase
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_refresh_tokens(s, n_tokens=1)

        async with Session() as s:
            epoch = await revoke_user_sessions(s, user_id, firebase_uid="fb-uid-1")
        assert epoch is not None

        async with Session() as s:
            stored = await get_auth_valid_after(s, user_id)
            assert stored is not None
    finally:
        await engine.dispose()
