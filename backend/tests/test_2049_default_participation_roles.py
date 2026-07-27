"""SID 265f5b13/#2049 AC3: 실DB 회귀 테스트 — 신규 조직에 기본 참여 역할이 생기고,
그 역할로 resolve_implementation_participation이 None을 반환하지 않는지.

배경: #2047 AC5 라이브 검증 중 dev 테스트 조직 4곳 중 3곳이 참여 역할 0개, 1곳은
is_default=True 역할이 없는 상태였다 — merge_verdict_gate의 no-substance chokepoint(#2047)에
닿기도 전에 "no implementation participation"으로 조기 반환돼 게이트가 원천적으로 안 생겼다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    return _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )


async def _engine_and_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.anyio
async def test_new_org_gets_default_participation_role():
    """ⓐ OrganizationRepository.create() 직후 is_default=True 역할이 존재한다."""
    from app.core.database import Base
    from app.repositories.organization import OrganizationRepository

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            repo = OrganizationRepository(s)
            org = await repo.create(name="AC3 Test Org", slug=f"ac3-{uuid.uuid4().hex[:8]}", owner_member_id=None)
            await s.commit()
            assert org is not None

            from sqlalchemy import select
            from app.models.participation import ParticipationRole

            roles = (await s.execute(
                select(ParticipationRole).where(ParticipationRole.org_id == org.id)
            )).scalars().all()
            assert len(roles) == 5, f"기본 역할 5종이 생겨야: {[r.key for r in roles]}"
            default_roles = [r for r in roles if r.is_default]
            assert len(default_roles) == 1 and default_roles[0].key == "implementation", (
                f"is_default=True는 implementation 하나여야: {[(r.key, r.is_default) for r in roles]}"
            )
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_implementation_participation_not_none_for_new_org():
    """ⓑ 신규 조직에서 resolve_implementation_participation이 None을 반환하지 않는다
    (participation 행이 있으면) — #2047의 no-substance chokepoint에 실제로 도달 가능함을 증명."""
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.participation import Participation
    from app.models.pm import Story
    from app.repositories.organization import OrganizationRepository
    from app.services.verdict_capture import resolve_implementation_participation

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            repo = OrganizationRepository(s)
            org = await repo.create(name="AC3 Test Org 2", slug=f"ac3b-{uuid.uuid4().hex[:8]}", owner_member_id=None)
            await s.commit()

            from sqlalchemy import select
            from app.models.participation import ParticipationRole

            default_role = (await s.execute(
                select(ParticipationRole).where(
                    ParticipationRole.org_id == org.id, ParticipationRole.is_default.is_(True),
                ).limit(1)
            )).scalar_one()

            story_id, member_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Story(id=story_id, org_id=org.id, project_id=project_id, title="AC3", status="in-review"),
                Participation(
                    id=uuid.uuid4(), org_id=org.id, story_id=story_id,
                    member_id=member_id, role_id=default_role.id,
                ),
            ])
            await s.commit()

            participation = await resolve_implementation_participation(s, org.id, story_id)
            assert participation is not None, "기본 역할이 있으면 participation 해소가 None이면 안 된다"
            assert participation.member_id == member_id
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_org_without_participation_still_resolves_none_before_fix_scenario():
    """대조군: participation 행 자체가 없으면(정책 백필과 무관) 여전히 None이 맞다 —
    이 테스트가 무너지면 resolve_implementation_participation의 다른 불변식이 깨진 것."""
    from app.repositories.organization import OrganizationRepository
    from app.services.verdict_capture import resolve_implementation_participation
    from app.core.database import Base

    engine, Session = await _engine_and_session()
    try:
        async with Session() as s:
            repo = OrganizationRepository(s)
            org = await repo.create(name="AC3 Test Org 3", slug=f"ac3c-{uuid.uuid4().hex[:8]}", owner_member_id=None)
            await s.commit()

            participation = await resolve_implementation_participation(s, org.id, uuid.uuid4())
            assert participation is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
