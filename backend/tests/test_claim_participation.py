"""3414b6d7: claim/assignee가 implementation participation을 멱등 생성.

claim=일 시작=실작업자 → 게이트/verdict attribution을 위해 implementation(default) 역할
participation이 있어야 한다. ensure_implementation_participation(claim·assignee 공유 helper)이
멱등 생성하는지 실DB로 검증.
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


async def _count_part(session, org, story_id, member_id):
    from sqlalchemy import text as _text

    return (await session.execute(
        _text("SELECT count(*) FROM participation WHERE org_id=:o AND story_id=:s AND member_id=:m"),
        {"o": org, "s": story_id, "m": member_id},
    )).scalar()


@pytest.mark.anyio
async def test_ensure_implementation_participation_idempotent():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.participation import ParticipationRole
    from app.models.pm import Story
    from app.services.participation_helpers import ensure_implementation_participation

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id, member = (uuid.uuid4() for _ in range(4))

    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=uuid.uuid4(), org_id=org, key="implementation", label="구현",
                                  is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="backlog"),
            ])
            await s.commit()

        # ① claimer participation 생성(1건).
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            ok = await ensure_implementation_participation(s, org, story_id, member)
            await s.commit()
            assert ok is True
        async with Session() as s:
            assert await _count_part(s, org, story_id, member) == 1

        # 멱등: 재호출해도 1건(중복 0).
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            await ensure_implementation_participation(s, org, story_id, member)
            await s.commit()
        async with Session() as s:
            assert await _count_part(s, org, story_id, member) == 1
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_skips_when_no_default_role():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.pm import Story
    from app.services.participation_helpers import ensure_implementation_participation

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id, member = (uuid.uuid4() for _ in range(4))

    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(Story(id=story_id, org_id=org, project_id=project, title="S", status="backlog"))
            await s.commit()
        # default role 미시드 → skip(False)·participation 0(거짓 attribution 금지).
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            ok = await ensure_implementation_participation(s, org, story_id, member)
            await s.commit()
            assert ok is False
        async with Session() as s:
            assert await _count_part(s, org, story_id, member) == 0
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()
