"""story #4224(PO 판단 2026-09-23 22:35Z) — `resolve_org_locale`: 요청 로케일이 없는 발행이 쓰는 «org 기준 언어».
규칙: 가장 먼저 소유자가 된 사람 중 지원 로케일을 설정한 사람의 users.locale · 없으면 DEFAULT_LOCALE(ko)."""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _org(s):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="4224 org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    return org.id


_T0 = datetime(2026, 9, 1, tzinfo=UTC)


async def _member(s, org_id, *, role, locale, minutes, deleted=False):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x", locale=locale)
    s.add(user)
    await s.commit()
    s.add(OrgMember(
        id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role,
        created_at=_T0 + timedelta(minutes=minutes), deleted_at=(_T0 if deleted else None),
    ))
    await s.commit()


async def _run(seed):
    from app.services.org_locale import resolve_org_locale

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _org(s)
            await seed(s, org_id)
            return await resolve_org_locale(s, org_id)
    finally:
        await engine.dispose()


async def test_no_owner_falls_back_to_default():
    async def seed(s, org):
        await _member(s, org, role="member", locale="en", minutes=0)  # 소유자 아님 → 무시
    assert await _run(seed) == "ko"


async def test_single_owner_locale():
    async def seed(s, org):
        await _member(s, org, role="owner", locale="en", minutes=0)
    assert await _run(seed) == "en"


async def test_earliest_owner_wins():
    async def seed(s, org):
        await _member(s, org, role="owner", locale="en", minutes=10)
        await _member(s, org, role="owner", locale="ko", minutes=1)
    assert await _run(seed) == "ko"


async def test_owner_without_supported_locale_is_skipped():
    async def seed(s, org):
        await _member(s, org, role="owner", locale=None, minutes=1)
        await _member(s, org, role="owner", locale="fr", minutes=2)
        await _member(s, org, role="owner", locale="en", minutes=3)
    assert await _run(seed) == "en"


async def test_deleted_owner_is_ignored():
    async def seed(s, org):
        await _member(s, org, role="owner", locale="en", minutes=1, deleted=True)
        await _member(s, org, role="owner", locale=None, minutes=2)
    assert await _run(seed) == "ko"
