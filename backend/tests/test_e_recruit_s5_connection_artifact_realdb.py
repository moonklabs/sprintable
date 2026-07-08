"""E-RECRUIT S5 (story 4fca5a3e): connection-artifact 번들 실 Postgres 검증.

핵심: G4(persona.system_prompt가 공용 connection-artifact 레이어에서 파일로 emit되는지 — 실
AgentPersonaRepository.list()/_decorate() 경로, mock 아님) + connector 분기(포인터만·mcp_config
None) + 무-persona 하위호환(기존 .mcp.json 단일 파일 동작 회귀 없음).
"""
from __future__ import annotations

import json
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


async def _seed_agent(session, *, with_persona: bool):
    from sqlalchemy import text as _text
    from app.models.team import TeamMember
    from app.models.agent_deployment import AgentPersona

    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    await session.execute(_text("SET session_replication_role = replica"))

    agent = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="Test Agent", role="member",
    )
    session.add(agent)
    await session.flush()

    if with_persona:
        persona = AgentPersona(
            org_id=org_id, project_id=project_id, agent_id=agent.id,
            name="Backend Engineer", slug="backend",
            system_prompt="당신은 백엔드 엔지니어입니다. claim→status→소통 순으로 자율 운영하세요.",
            is_builtin=False, is_default=True,
            config={"role_template_id": str(uuid.uuid4()), "tool_allowlist": ["stories", "tasks"]},
        )
        session.add(persona)
        await session.flush()

    await session.commit()
    return agent, org_id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_connection_artifact_emits_persona_file_real_decorate_path():
    """G4: 실 AgentPersonaRepository.list()/_decorate() 경로(mock 아님)로 SPRINTABLE_ONBOARDING.md
    + .mcp.json 두 파일이 정확히 나오는지."""
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, org_id = await _seed_agent(s, with_persona=True)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            out = await get_agent_connection_artifact(
                agent.id, runtime="claude-code", session=s,
                accept_language=None, auth=MagicMock(), org_id=org_id,
            )

        assert len(out["files"]) == 2
        filenames = {f["filename"] for f in out["files"]}
        assert filenames == {"SPRINTABLE_ONBOARDING.md", ".mcp.json"}
        instruction = next(f for f in out["files"] if f["filename"] == "SPRINTABLE_ONBOARDING.md")
        assert "백엔드 엔지니어" in instruction["content"]
        mcp_file = next(f for f in out["files"] if f["filename"] == ".mcp.json")
        parsed = json.loads(mcp_file["content"])
        assert parsed["mcpServers"]["sprintable"]["type"] in ("stdio", "http")
        assert out["mcp_config"] == parsed
        assert out["api_key"] is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_connection_artifact_no_persona_backward_compatible_real_db():
    """무-persona 에이전트(미채용) — 지침 파일 없이 .mcp.json 만(기존 동작 회귀 없음)."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, org_id = await _seed_agent(s, with_persona=False)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            out = await get_agent_connection_artifact(
                agent.id, runtime="claude-code", session=s,
                accept_language=None, auth=MagicMock(), org_id=org_id,
            )

        assert len(out["files"]) == 1
        assert out["files"][0]["filename"] == ".mcp.json"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_connection_artifact_connector_runtime_real_db():
    """connector 런타임 — persona 있어도 mcp_config는 None, 포인터 파일만 추가(+ 지침 파일은 여전히
    포함 — G4는 런타임 무관 공용 레이어)."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, org_id = await _seed_agent(s, with_persona=True)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            out = await get_agent_connection_artifact(
                agent.id, runtime="connector", session=s,
                accept_language=None, auth=MagicMock(), org_id=org_id,
            )

        assert out["mcp_config"] is None
        filenames = {f["filename"] for f in out["files"]}
        assert filenames == {"SPRINTABLE_ONBOARDING.md", "CONNECTOR_SETUP.md"}
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
@pytest.mark.parametrize("runtime", ["opencode", "openclaw", "hermes", "grok", "pi"])
async def test_connection_artifact_connector_only_runtimes_real_db(runtime):
    """전 런타임 올지원(story 6f6ac081): 커넥터 전용 5종도 connector 버킷과 동형 — mcp_config는
    None, CONNECTOR_SETUP.md 포인터 파일 emit. 채용-kit 재설계(story b1fe41cf) 이후 instruction
    파일명은 런타임 무관 SPRINTABLE_ONBOARDING.md 단일 상수."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent, org_id = await _seed_agent(s, with_persona=True)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            out = await get_agent_connection_artifact(
                agent.id, runtime=runtime, session=s,
                accept_language=None, auth=MagicMock(), org_id=org_id,
            )

        assert out["mcp_config"] is None
        filenames = {f["filename"] for f in out["files"]}
        assert filenames == {"SPRINTABLE_ONBOARDING.md", "CONNECTOR_SETUP.md"}
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_connection_artifact_no_default_persona_omits_instruction_file():
    """까심 QA RC(S5): persona가 존재해도 전부 ``is_default=False``면(POST /agent-personas가
    is_default 생략 시 non-default 생성 가능 — "정확히 1개 default" 불변식 없음) list()의
    ``ORDER BY is_default DESC, created_at ASC`` 정렬 때문에 가장 오래된 non-default persona가
    [0]에 온다. 그 persona의 system_prompt를 authoritative처럼 emit하면 안 됨 — 지침 파일 생략
    (안전 fallback, .mcp.json만)이 맞다."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.models.agent_deployment import AgentPersona
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = uuid.uuid4(), uuid.uuid4()
            await s.execute(_text("SET session_replication_role = replica"))
            agent = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="Test Agent", role="member",
            )
            s.add(agent)
            await s.flush()
            # 의도적으로 is_default=False인 persona만 존재(예: is_default 생략된 수기 생성).
            persona = AgentPersona(
                org_id=org_id, project_id=project_id, agent_id=agent.id,
                name="Draft Persona", slug="draft",
                system_prompt="이건 authoritative 지침이 아니어야 함.",
                is_builtin=False, is_default=False,
            )
            s.add(persona)
            await s.flush()
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            out = await get_agent_connection_artifact(
                agent.id, runtime="claude-code", session=s,
                accept_language=None, auth=MagicMock(), org_id=org_id,
            )

        assert len(out["files"]) == 1  # 지침 파일 생략 — .mcp.json만
        assert out["files"][0]["filename"] == ".mcp.json"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
