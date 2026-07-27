"""OSS fresh-install gap: org 생성 시 default participation role 시드.

participation_role 이 org별로 비어 있으면 ensure_implementation_participation 이 skip →
implementation participation 0 → merge gate 가 "no implementation participation" ask_human
(gate row 미생성)으로 영구 보류된다 — 사람이 승인할 게이트조차 없는 교착. 시드 경로가
아예 없어 fresh 설치의 모든 신규 org 가 이 상태였다(2026-07-10 gate smoke E2E 실측).

fix: OrganizationRepository.create 가 org 생성 직후 default 역할(key=implementation)을
멱등 시드한다. 기존 org 에 역할이 이미 있으면(명시 설정) 건드리지 않는다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _engine_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


async def _default_roles(session, org_id):
    from sqlalchemy import text as _text

    return (await session.execute(
        _text(
            "SELECT key, is_default FROM participation_role WHERE org_id = :o ORDER BY key"
        ),
        {"o": org_id},
    )).all()


@pytest.mark.anyio
async def test_org_create_seeds_default_implementation_role():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.participation import ParticipationRole  # noqa: F401 — create_all 등록
    from app.repositories.organization import OrganizationRepository

    engine = create_async_engine(_engine_url())
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            repo = OrganizationRepository(s)
            org = await repo.create(name="Fresh Org", slug=f"fresh-{uuid.uuid4().hex[:8]}", owner_member_id=None)
            assert org is not None
            await s.commit()
            org_id = org.id

        # 신규 org 는 default implementation 역할을 갖고 태어난다 — merge gate attribution 성립.
        async with Session() as s:
            rows = await _default_roles(s, org_id)
            assert ("implementation", True) in [(r.key, r.is_default) for r in rows]
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_seed_respects_existing_roles():
    """이미 역할이 있는 org(명시 설정)는 시드가 덮어쓰지 않는다."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.participation import ParticipationRole
    from app.services.participation_helpers import seed_default_participation_role

    engine = create_async_engine(_engine_url())
    org_id = uuid.uuid4()
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            s.add(ParticipationRole(
                id=uuid.uuid4(), org_id=org_id, key="custom", label="커스텀", is_default=False,
            ))
            await s.commit()

        # 역할이 하나라도 있으면(비록 default 가 없어도) 명시 설정으로 보고 시드 skip.
        async with Session() as s:
            created = await seed_default_participation_role(s, org_id)
            await s.commit()
            assert created is False
        async with Session() as s:
            rows = await _default_roles(s, org_id)
            assert [(r.key, r.is_default) for r in rows] == [("custom", False)]
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_seed_idempotent_on_empty_org():
    """빈 org 에 두 번 호출해도 default 역할은 1행(멱등)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.services.participation_helpers import seed_default_participation_role

    engine = create_async_engine(_engine_url())
    org_id = uuid.uuid4()
    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            assert await seed_default_participation_role(s, org_id) is True
            await s.commit()
        async with Session() as s:
            assert await seed_default_participation_role(s, org_id) is False
            await s.commit()
        async with Session() as s:
            rows = await _default_roles(s, org_id)
            assert [(r.key, r.is_default) for r in rows] == [("implementation", True)]
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()
