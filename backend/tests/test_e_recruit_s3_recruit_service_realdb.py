"""E-RECRUIT S3 (story ff2996d0): recruit_agent 실 Postgres 검증.

핵심: G7(재채용/역할변경=persona upsert — 같은 agent 재recruit이 새 행을 만들지 않고 기존
recruit-persona 행을 갱신하는지) + 키 revoke-후-재발급(이전 키 비활성화·신규 키가 새 role
scope 를 갖는지) + QA MINOR fail-closed(오염된 tool_groups 면 아무 write 도 없이 raise).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 컨벤션: create_all/drop_all 자체 스키마 관리 — 공유 alembic-migrated DB 오염 방지.
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


async def _seed_agent_and_role_templates(session):
    from sqlalchemy import text as _text
    from app.models.team import TeamMember
    from app.models.role_template import RoleTemplate
    from app.repositories.api_key import ApiKeyRepository
    from app.services.mcp_toolset import ALL_GROUPS

    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    await session.execute(_text("SET session_replication_role = replica"))

    agent = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="Test Agent", role="member",
    )
    backend_rt = RoleTemplate(
        id=uuid.uuid4(), slug="backend", name="Backend Engineer", category="engineering",
        role_behaviors="백엔드 자율 운영 지침.",
        default_tool_groups=["stories", "tasks", "chat", "docs"],
        is_published=True,
    )
    qa_rt = RoleTemplate(
        id=uuid.uuid4(), slug="qa", name="QA Engineer", category="quality",
        role_behaviors="QA 자율 운영 지침.",
        default_tool_groups=["stories", "tasks", "chat", "docs", "retro"],
        is_published=True,
    )
    bogus_rt = RoleTemplate(
        id=uuid.uuid4(), slug="bogus", name="Bogus Role", category="broken",
        role_behaviors="오염된 role.",
        default_tool_groups=["stories", "not-a-real-group"],
        is_published=True,
    )
    session.add_all([agent, backend_rt, qa_rt, bogus_rt])
    await session.flush()

    # POST /agents 가 만드는 것과 동일한 초기 ALL_GROUPS 기본 키(recruit이 이걸 좁혀야 함).
    _key, _plaintext = await ApiKeyRepository(session).create(
        team_member_id=agent.id, scope=list(ALL_GROUPS)
    )
    await session.commit()
    return agent, backend_rt, qa_rt, bogus_rt, org_id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_first_recruit_creates_persona_and_narrows_key_scope():
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.agent_deployment import AgentPersona
    from app.models.api_key import ApiKey
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, backend_rt, _qa_rt, _bogus_rt, org_id = await _seed_agent_and_role_templates(s)

            result = await recruit_agent(
                s, agent_member=agent, org_id=org_id, role_template=backend_rt,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

            assert result["tool_allowlist"] == ["stories", "tasks", "chat", "docs"]
            assert result["api_key_plaintext"].startswith("sk_live_")

        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent.id)
            )).scalars().all()
            assert len(personas) == 1
            assert personas[0].config["role_template_id"] == str(backend_rt.id)
            assert personas[0].config["tool_allowlist"] == ["stories", "tasks", "chat", "docs"]
            assert personas[0].is_default is True

            keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == agent.id)
            )).scalars().all()
            assert len(keys) == 2  # 원본(ALL_GROUPS) + recruit이 회전한 신규
            active = [k for k in keys if k.revoked_at is None]
            revoked = [k for k in keys if k.revoked_at is not None]
            assert len(active) == 1
            assert len(revoked) == 1
            assert active[0].scope == ["stories", "tasks", "chat", "docs"]
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_re_recruit_into_different_role_upserts_same_persona_and_rotates_key():
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.agent_deployment import AgentPersona
    from app.models.api_key import ApiKey
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, backend_rt, qa_rt, _bogus_rt, org_id = await _seed_agent_and_role_templates(s)
            first = await recruit_agent(
                s, agent_member=agent, org_id=org_id, role_template=backend_rt,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()
            first_persona_id = first["persona"].id

        async with Session() as s:
            # role change: backend → qa (동일 agent)
            agent_ref = (await s.execute(
                select(agent.__class__).where(agent.__class__.id == agent.id)
            )).scalar_one()
            second = await recruit_agent(
                s, agent_member=agent_ref, org_id=org_id, role_template=qa_rt,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent.id)
            )).scalars().all()
            # G7: 새 행이 아니라 같은 행 upsert — 정확히 1개만 존재.
            assert len(personas) == 1
            assert personas[0].id == first_persona_id
            assert personas[0].config["role_template_id"] == str(qa_rt.id)
            assert personas[0].config["tool_allowlist"] == ["stories", "tasks", "chat", "docs", "retro"]
            assert personas[0].name == "QA Engineer"

            keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == agent.id)
            )).scalars().all()
            assert len(keys) == 3  # 원본 + 1차 recruit 회전 + 2차 recruit 회전
            active = [k for k in keys if k.revoked_at is None]
            assert len(active) == 1
            assert active[0].scope == ["stories", "tasks", "chat", "docs", "retro"]
            assert second["persona"].id == first_persona_id
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_corrupt_tool_groups_fails_closed_with_no_writes():
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.agent_deployment import AgentPersona
    from app.models.api_key import ApiKey
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, _backend_rt, _qa_rt, bogus_rt, org_id = await _seed_agent_and_role_templates(s)

            with pytest.raises(ValueError, match="unknown group"):
                await recruit_agent(
                    s, agent_member=agent, org_id=org_id, role_template=bogus_rt,
                    runtime="claude-code", actor_id=uuid.uuid4(),
                )
            await s.rollback()

        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent.id)
            )).scalars().all()
            assert personas == []  # fail-closed — persona 미생성

            keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == agent.id)
            )).scalars().all()
            assert len(keys) == 1  # 시드 시점 원본 키만(회전 없음)
            assert keys[0].revoked_at is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
