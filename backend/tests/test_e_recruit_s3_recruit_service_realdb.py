"""E-RECRUIT S3 (story ff2996d0): recruit_agent 실 Postgres 검증.

핵심: G7(재채용/역할변경=persona upsert — 같은 agent 재recruit이 새 행을 만들지 않고 기존
recruit-persona 행을 갱신하는지) + 키 revoke-후-재발급(이전 키 비활성화·신규 키가 새 role
scope 를 갖는지) + QA MINOR fail-closed(오염된 tool_groups 면 아무 write 도 없이 raise).

까심 QA RC(S3) 후속 fix 검증: HIGH(동시 recruit 2콜 직렬화 — advisory lock) + MEDIUM
(description stale + config 병합 orphan 키 잔존).
"""
from __future__ import annotations

import asyncio
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
            agent_id = agent.id  # rollback 이 agent 인스턴스를 expire 시키므로 값을 미리 캡처

            with pytest.raises(ValueError, match="unknown group"):
                await recruit_agent(
                    s, agent_member=agent, org_id=org_id, role_template=bogus_rt,
                    runtime="claude-code", actor_id=uuid.uuid4(),
                )
            await s.rollback()

        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent_id)
            )).scalars().all()
            assert personas == []  # fail-closed — persona 미생성

            keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == agent_id)
            )).scalars().all()
            assert len(keys) == 1  # 시드 시점 원본 키만(회전 없음)
            assert keys[0].revoked_at is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_concurrent_recruit_calls_serialize_to_one_persona_and_one_active_key():
    """까심 QA HIGH(S3 RC): 동일 agent 에 대한 동시 recruit 2콜(서로 다른 role_template, 서로 다른
    DB 커넥션/세션)이 advisory lock 으로 직렬화돼 persona 2행/active 키 2개로 안 갈라지는지 실증.
    """
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.agent_deployment import AgentPersona
    from app.models.api_key import ApiKey
    from app.models.role_template import RoleTemplate
    from app.models.team import TeamMember
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()

    async def _do_recruit(agent_id, org_id, role_template_id):
        from sqlalchemy import text as _text
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            agent_ref = (await s.execute(
                select(TeamMember).where(TeamMember.id == agent_id)
            )).scalar_one()
            rt_ref = (await s.execute(
                select(RoleTemplate).where(RoleTemplate.id == role_template_id)
            )).scalar_one()
            result = await recruit_agent(
                s, agent_member=agent_ref, org_id=org_id, role_template=rt_ref,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()
            return result

    try:
        async with Session() as s:
            agent, backend_rt, qa_rt, _bogus_rt, org_id = await _seed_agent_and_role_templates(s)
            agent_id = agent.id

        results = await asyncio.gather(
            _do_recruit(agent_id, org_id, backend_rt.id),
            _do_recruit(agent_id, org_id, qa_rt.id),
        )
        assert all(r is not None for r in results)

        async with Session() as s:
            personas = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent_id)
            )).scalars().all()
            assert len(personas) == 1  # 락 없으면 2행이 됐을 시나리오

            keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == agent_id)
            )).scalars().all()
            active = [k for k in keys if k.revoked_at is None]
            assert len(active) == 1  # 락 없으면 scope 다른 active 키 2개가 됐을 시나리오
            # 승자가 backend 든 qa 든, persona.config 와 active key.scope 는 반드시 같은 role 값이어야 함
            # (G2/G3 단일소스 — 서로 다른 role 값이 섞이면 안 됨).
            assert personas[0].config["tool_allowlist"] == active[0].scope
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_re_recruit_into_null_description_role_clears_stale_description():
    """까심 QA MEDIUM(persona description stale, agent_persona.py:244): 새 role_template 의
    description 이 None 이면, 이전 role 에서 물려받은 description 이 잔존하면 안 된다."""
    from sqlalchemy import select
    from app.core.database import Base
    from app.models.agent_deployment import AgentPersona
    from app.models.role_template import RoleTemplate
    from app.services.recruit_service import recruit_agent

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, backend_rt, _qa_rt, _bogus_rt, org_id = await _seed_agent_and_role_templates(s)
            backend_rt.description = "백엔드 직무 설명(1차 채용에 남아있으면 안 되는 값)"
            no_desc_rt = RoleTemplate(
                id=uuid.uuid4(), slug="no-desc", name="No Description Role", category="misc",
                role_behaviors="설명 없는 role.", default_tool_groups=["stories"],
                description=None, is_published=True,
            )
            s.add(no_desc_rt)
            await s.flush()

            await recruit_agent(
                s, agent_member=agent, org_id=org_id, role_template=backend_rt,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

        async with Session() as s:
            agent_ref = (await s.execute(
                select(agent.__class__).where(agent.__class__.id == agent.id)
            )).scalar_one()
            await recruit_agent(
                s, agent_member=agent_ref, org_id=org_id, role_template=no_desc_rt,
                runtime="claude-code", actor_id=uuid.uuid4(),
            )
            await s.commit()

        async with Session() as s:
            persona = (await s.execute(
                select(AgentPersona).where(AgentPersona.agent_id == agent.id)
            )).scalar_one()
            assert persona.description is None  # 이전 role 의 description 잔존 X
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_partial_recruit_config_touch_does_not_leak_stale_key_but_preserves_unrelated():
    """까심 QA MEDIUM(config 병합 orphan 키 잔존, agent_persona.py:228): recruit-managed 네임스페이스
    (role_template_id/tool_allowlist) 중 일부만 갱신되는 상황에서도 이전 값이 orphan 으로 안 남고,
    recruit 과 무관한 config 키(base_persona_id)는 그대로 보존되는지 — repository 레벨 화이트박스 검증
    (오늘의 recruit_agent 호출 패턴은 항상 둘 다 같이 넘기지만, 이 계약 자체를 직접 확인)."""
    from app.core.database import Base
    from app.repositories.agent_persona import AgentPersonaRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            repo = AgentPersonaRepository(s)
            org_id, project_id, agent_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            from sqlalchemy import text as _text
            await s.execute(_text("SET session_replication_role = replica"))

            created = await repo.create(
                org_id=org_id, project_id=project_id, agent_id=agent_id, actor_id=uuid.uuid4(),
                name="Stale Role", tool_allowlist=["stale-group"],
                role_template_id=uuid.uuid4(), base_persona_id=uuid.uuid4(),
            )
            await s.commit()
            persona_id = created.id

        async with Session() as s:
            repo = AgentPersonaRepository(s)
            # role_template_id 를 생략하고 tool_allowlist 만 갱신(부분 touch) — 이전 role_template_id
            # 가 orphan 으로 남으면 안 됨.
            updated = await repo.update(
                persona_id, org_id, project_id, uuid.uuid4(),
                tool_allowlist=["fresh-group"],
            )
            await s.commit()

            assert updated.config["tool_allowlist"] == ["fresh-group"]
            assert "role_template_id" not in updated.config  # orphan 안 남음(wholesale 클리어)
            assert updated.base_persona_id is not None  # recruit 과 무관한 키는 보존
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
