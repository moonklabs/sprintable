"""story b07ad526(E-AUTH-REBUILD M2 Phase1-S1) 게이트: auth_identities/auth_migrations/
auth_migration_events 스키마 실 PG 왕복 + 제약 실증. 전부 additive — 기존 인증 스위트는
별도로 무회귀 확認(플래그 전부 off라 동작 변화 0)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


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
        id=user_id, email=f"authreb-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    return user_id


@pytest.mark.anyio
async def test_auth_identity_insert_and_unique_issuer_subject_realdb():
    from app.models.auth_identity import AuthIdentity
    from sqlalchemy.exc import IntegrityError

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            issuer = f"https://session.firebase.google.com/test-{uuid.uuid4().hex[:6]}"
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_id, issuer=issuer, subject=str(user_id),
                provider_id="password", email_at_link="a@test.com",
            ))
            await s.commit()

        # 동일 (issuer, subject) 재삽입 — UNIQUE 위반.
        async with Session() as s:
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_id, issuer=issuer, subject=str(user_id),
                provider_id="google.com",
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_auth_identity_partial_unique_provider_subject_only_active_realdb():
    """까심: unlinked_at IS NOT NULL(해제된 링크)은 partial unique에서 제외 — 재연동 가능해야 함.
    동시에 두 개의 linked(unlinked_at IS NULL) 행이 같은 provider 조합을 가지면 거부돼야 함."""
    from app.models.auth_identity import AuthIdentity
    from sqlalchemy.exc import IntegrityError
    from datetime import datetime, timezone

    engine, Session = await _session_factory()
    try:
        issuer = f"https://session.firebase.google.com/test-{uuid.uuid4().hex[:6]}"
        provider_subject = f"google-sub-{uuid.uuid4().hex[:8]}"

        async with Session() as s:
            user_a = await _seed_user(s)
            user_b = await _seed_user(s)

        # user_a가 이 provider_subject를 링크했다가 해제(unlinked_at 설정).
        async with Session() as s:
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_a, issuer=issuer, subject=f"a-{user_a}",
                provider_id="google.com", provider_subject=provider_subject,
                unlinked_at=datetime.now(timezone.utc),
            ))
            await s.commit()

        # user_b가 같은 provider_subject를 새로 링크(active) — 해제된 링크와 충돌하지 않아야 함.
        async with Session() as s:
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_b, issuer=issuer, subject=f"b-{user_b}",
                provider_id="google.com", provider_subject=provider_subject,
            ))
            await s.commit()

        # 이제 user_a가 동일 provider_subject를 다시 active로 링크 시도 — 이미 user_b가
        # active 보유 중이라 partial unique 위반.
        async with Session() as s:
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_a, issuer=issuer, subject=f"a2-{user_a}",
                provider_id="google.com", provider_subject=provider_subject,
            ))
            with pytest.raises(IntegrityError):
                await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_auth_migration_default_state_legacy_realdb():
    from app.models.auth_identity import AuthMigration
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            s.add(AuthMigration(user_id=user_id))
            await s.commit()

        async with Session() as s:
            row = (await s.execute(
                select(AuthMigration).where(AuthMigration.user_id == user_id)
            )).scalar_one()
            assert row.state == "legacy"
            assert row.attempt_count == 0
            assert row.mfa_reenroll_required is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_auth_migration_event_append_only_realdb():
    from app.models.auth_identity import AuthMigrationEvent
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user(s)
            s.add(AuthMigrationEvent(
                id=uuid.uuid4(), user_id=user_id, from_state="legacy", to_state="provisioning",
                method="forced_reset", reason_code="cutover_start",
            ))
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(AuthMigrationEvent).where(AuthMigrationEvent.user_id == user_id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].to_state == "provisioning"
    finally:
        await engine.dispose()


def test_firebase_auth_flags_default_off_except_legacy():
    """story b07ad526 AC2: 8개 플래그 default가 doc §10.1과 일치 — LEGACY_AUTH_ISSUE/VERIFY만 true."""
    from app.core.config import Settings

    s = Settings(_env_file=None)
    assert s.firebase_auth_accept_id is False
    assert s.firebase_auth_accept_session is False
    assert s.firebase_auth_issue_session is False
    assert s.firebase_auth_reset_cutover is False
    assert s.firebase_auth_cohort_percent == 0
    assert s.firebase_auth_mobile_issue is False
    assert s.legacy_auth_issue is True
    assert s.legacy_auth_verify is True
