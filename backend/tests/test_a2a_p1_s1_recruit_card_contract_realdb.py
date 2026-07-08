"""E-A2A-P1 S1(story b6b7227b): recruit 완료 → A2A Card 즉시반영 계약 lock(realdb).

PO 지시(2026-07-06): "검증만 하고 끝내지 말고 회귀 테스트로 박아" — recruit_agent() 커밋 직후
별도 코드 없이 `_build_agent_card`가 role_template 기반 skill을 즉시 반영하는 게 P1-S1의 실제
프로덕션 계약이다. 미래 recruit/Card 리팩터가 이 즉시성을 깨면 이 테스트가 잡는다.

DB env 없으면 skip(CI alembic-fresh) — `test_e_recruit_s3_recruit_service_realdb.py` 패턴
재사용(create_all 하에선 team_members가 flat table이라 FK 비활성화 후 직접 ORM insert).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마를 직접 다룸 — 격리 DB 전용.
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_recruit_completion_immediately_reflected_in_a2a_card():
    from sqlalchemy import text, select
    from app.core.database import Base
    from app.models.role_template import RoleTemplate
    from app.models.team import TeamMember
    from app.routers.a2a import _build_agent_card
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        agent_id = uuid.uuid4()

        async with Session() as s:
            await s.execute(text("SET session_replication_role = replica"))

            agent = TeamMember(
                id=agent_id, org_id=org_id, project_id=project_id, type="agent",
                name="NewHire", role="member", is_active=True,
            )
            qa_rt = RoleTemplate(
                id=uuid.uuid4(), slug="qa", name="QA Engineer", category="quality",
                role_behaviors="QA 자율 운영 지침.",
                default_tool_groups=["stories", "chat"],
                is_published=True,
            )
            s.add_all([agent, qa_rt])
            await s.flush()
            await s.commit()
            role_template_id = qa_rt.id

        # 1. pre-recruit: persona 없음 — S1 fallback(id="unassigned", tags=[]).
        async with Session() as s:
            member = (await s.execute(
                select(TeamMember).where(TeamMember.id == agent_id)
            )).scalars().first()
            pre_card = await _build_agent_card(s, member, "http://test")
            assert pre_card.skills[0].id == "unassigned"
            assert pre_card.skills[0].tags == []

        # 2. recruit 완료 — 신규 A2A 코드 없이 기존 recruit_agent() 서비스만 호출.
        async with Session() as s:
            member = (await s.execute(
                select(TeamMember).where(TeamMember.id == agent_id)
            )).scalars().first()
            role_template = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.id == role_template_id)
            )).scalar_one()

            await recruit_agent(
                s, agent_member=member, org_id=org_id, role_template=role_template,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

        # 3. recruit 커밋 직후, 같은 트랜잭션 경계 밖에서 Card를 재조립 — 신규 코드 없이 즉시 반영 확認.
        async with Session() as s:
            member = (await s.execute(
                select(TeamMember).where(TeamMember.id == agent_id)
            )).scalars().first()
            post_card = await _build_agent_card(s, member, "http://test")
            assert post_card.skills[0].id == "qa", "recruit 완료가 Card에 즉시 반영되지 않음(P1-S1 계약 위반)"
            assert set(post_card.skills[0].tags) == {"stories", "chat"}
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
