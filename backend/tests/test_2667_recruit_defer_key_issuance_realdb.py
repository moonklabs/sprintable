"""story #2667(2026-08-15, 선생님 실환 제보) — recruit 완료가 최초 자동 키를 조용히 rotate.

PO 방향 판정(ⓐ 근본): recruit 위저드의 create→recruit 연속 호출에서, create가 defer_key_issuance=
True를 받으면 키를 발급하지 않는다 — 뒤이은 recruit()의 _rotate_or_create_key가 활성 키를
못 찾아 create 분기(role-scope 바인딩 키 1회 발급)를 타서 rotate 자체가 발생하지 않는다.

판별자: 동의 없는 키 무효화 경로 0 — 이 파일은 create(defer)→recruit 왕복에서 API 키가
정확히 «1개만» 생성되고 한 번도 rotate(revoke)되지 않았음을 실 DB로 확認한다. defer=False(기존
경로, 예: equip-skip 후 나중에 recruit)는 여전히 rotate가 나야 한다는 회귀가드도 같이 둔다
(test_e_recruit_s3_recruit_service_realdb.py의 선례와 동일 축 — 그쪽은 무변경으로 남겨둔다)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_and_role(session):
    from sqlalchemy import text as _text
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.role_template import RoleTemplate

    await session.execute(_text("SET session_replication_role = replica"))
    org = Organization(id=uuid.uuid4(), name="Acme", slug=f"acme-{uuid.uuid4().hex[:8]}")
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Main", slug="main")
    role = RoleTemplate(
        id=uuid.uuid4(), slug="backend", name="Backend Engineer", category="engineering",
        role_behaviors="백엔드 자율 운영 지침.",
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        is_published=True,
    )
    session.add_all([org, project, role])
    await session.flush()
    return org, project, role


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_defer_key_issuance_then_recruit_creates_exactly_one_key_never_rotated():
    from sqlalchemy import select
    from app.models.api_key import ApiKey
    from app.services.org_agent import create_org_level_agent
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, role = await _seed_org_project_and_role(s)

            member, create_key = await create_org_level_agent(
                s, org_id=org.id, created_by=None, name="Deferred Agent",
                project_ids=[project.id], defer_key_issuance=True,
            )
            await s.commit()

            # AC 판별자 핵심: create 시점에 키가 아예 없다(발급 자체가 없었다).
            assert create_key is None
            rows_after_create = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == member.id)
            )).scalars().all()
            assert rows_after_create == []

            result = await recruit_agent(
                s, agent_member=member, org_id=org.id, role_template=role,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

            assert result["api_key_plaintext"]  # recruit이 발급한 그 키가 사용자에게 노출됨
            rows_after_recruit = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == member.id)
            )).scalars().all()
            # 정확히 1개 — create가 만든 키를 rotate로 죽인 게 아니라, recruit이 처음이자
            # 유일하게 발급한 것(단일 소스).
            assert len(rows_after_recruit) == 1
            assert rows_after_recruit[0].revoked_at is None
            assert set(rows_after_recruit[0].scope) == set(role.default_tool_groups)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_default_no_defer_still_issues_key_at_create_time_no_regression():
    """defer_key_issuance 기본값(False) — equip-skip류 create-only 소비자는 여전히 즉시 키를
    받는다(PO: 「equip-skip은 현행 유지」). 이 플래그를 명시 안 넘기는 기존 호출부는 무회귀."""
    from sqlalchemy import select
    from app.models.api_key import ApiKey
    from app.services.org_agent import create_org_level_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, project, _role = await _seed_org_project_and_role(s)

            member, create_key = await create_org_level_agent(
                s, org_id=org.id, created_by=None, name="Immediate Agent",
                project_ids=[project.id],
            )
            await s.commit()

            assert create_key is not None
            rows = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == member.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].revoked_at is None
    finally:
        await engine.dispose()
