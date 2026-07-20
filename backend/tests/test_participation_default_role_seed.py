"""SPR-35: 신규 org 기본 participation_role lazy 시드.

도그푸드 1차 실측(2026-07-19): 신규 org에 default role(implementation)이 시드되지 않아
claim해도 participation이 안 생기고, participation 없으면 report_done이 게이트 없이 auto
done — 신규 조직은 merge gate가 아예 작동하지 않았다(SQL 수동 시드로 우회).

수리 계약: ``ensure_implementation_participation``(claim·assignee 공용 chokepoint)이 default
역할 부재 시 **lazy 시드**한다. 단, 'implementation' key 역할이 이미 있는데 default가 아니면
org의 명시 설정으로 보고 건드리지 않는다(기존 skip 동작 보존). (org, key) 유니크 제약 +
ON CONFLICT로 동시 claim 경쟁 흡수.
"""
from __future__ import annotations

import contextlib
import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@contextlib.asynccontextmanager
async def _db():
    """격리 DB create_all → 단일 세션(replica 모드·FK 우회) → drop_all. (SPR-34 테스트 동형)"""
    if not _REAL_DB_URL:
        pytest.skip("PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models import gate, hitl_config, participation, pm, verdict  # noqa: F401

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            yield s
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


async def _roles(s, org):
    from sqlalchemy import select

    from app.models.participation import ParticipationRole

    return (await s.execute(
        select(ParticipationRole).where(ParticipationRole.org_id == org)
    )).scalars().all()


async def _participations(s, org):
    from sqlalchemy import select

    from app.models.participation import Participation

    return (await s.execute(
        select(Participation).where(Participation.org_id == org)
    )).scalars().all()


@pytest.mark.anyio
async def test_no_roles_at_all_lazy_seeds_default_and_participates():
    """핵심: 역할 0개인 신규 org — claim 경로가 default implementation 역할을 시드하고
    participation까지 생성한다(True)."""
    from app.services.participation_helpers import ensure_implementation_participation

    org, story, member = (uuid.uuid4() for _ in range(3))
    async with _db() as s:
        ok = await ensure_implementation_participation(s, org, story, member)
        assert ok is True, "default 역할이 없어도 lazy 시드로 성공해야"

        roles = await _roles(s, org)
        assert len(roles) == 1
        assert roles[0].key == "implementation" and roles[0].is_default is True

        parts = await _participations(s, org)
        assert len(parts) == 1
        assert parts[0].member_id == member and parts[0].role_id == roles[0].id


@pytest.mark.anyio
async def test_existing_default_role_reused_not_duplicated():
    """default 역할이 이미 있으면 그대로 사용 — 역할 추가 생성 금지(기존 동작 불변)."""
    from app.models.participation import ParticipationRole
    from app.services.participation_helpers import ensure_implementation_participation

    org, story, member = (uuid.uuid4() for _ in range(3))
    async with _db() as s:
        existing = ParticipationRole(id=uuid.uuid4(), org_id=org, key="builder",
                                     label="빌더", is_default=True)
        s.add(existing)
        await s.flush()

        ok = await ensure_implementation_participation(s, org, story, member)
        assert ok is True
        roles = await _roles(s, org)
        assert len(roles) == 1 and roles[0].id == existing.id


@pytest.mark.anyio
async def test_non_default_implementation_role_respected_no_flip():
    """'implementation' key 역할이 있는데 default가 아니면 — org 명시 설정 존중,
    is_default를 뒤집지 않고 기존처럼 False(skip)."""
    from app.models.participation import ParticipationRole
    from app.services.participation_helpers import ensure_implementation_participation

    org, story, member = (uuid.uuid4() for _ in range(3))
    async with _db() as s:
        s.add(ParticipationRole(id=uuid.uuid4(), org_id=org, key="implementation",
                                label="구현", is_default=False))
        await s.flush()

        ok = await ensure_implementation_participation(s, org, story, member)
        assert ok is False, "명시 비-default 설정은 건드리지 않는다"
        roles = await _roles(s, org)
        assert len(roles) == 1 and roles[0].is_default is False
        assert await _participations(s, org) == []


@pytest.mark.anyio
async def test_double_call_idempotent_single_role_single_participation():
    """연속 2회 호출 — 역할 1개·participation 1개(멱등)."""
    from app.services.participation_helpers import ensure_implementation_participation

    org, story, member = (uuid.uuid4() for _ in range(3))
    async with _db() as s:
        assert await ensure_implementation_participation(s, org, story, member) is True
        assert await ensure_implementation_participation(s, org, story, member) is True
        assert len(await _roles(s, org)) == 1
        assert len(await _participations(s, org)) == 1
