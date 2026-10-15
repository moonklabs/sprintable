"""story #4546 AC3 — GET /api/v2/api-keys/{key_id}/usage-summary: where one key's calls came from (real PG).

through our MCP client (by transport) vs direct · top paths with ids folded to {id} · top tools · top client addresses · only this
key · only the window · the same gate as the row list (assert_agent_owner): the creator reads it, a stranger in the same org and a
caller from another org do not, an unknown key is 404."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


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


async def _drop_all(engine) -> None:
    from app.core.database import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def _seed_agent_with_key(session, *, org_id: uuid.UUID, created_by: uuid.UUID):
    from sqlalchemy import text as _text
    from app.models.team import TeamMember
    from app.repositories.api_key import ApiKeyRepository

    await session.execute(_text("SET session_replication_role = replica"))
    agent = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
        name="4546 Agent", role="member", created_by=created_by,
    )
    session.add(agent)
    await session.flush()
    key, _plaintext = await ApiKeyRepository(session).create(team_member_id=agent.id, scope=["read"], expires_at=None)
    await session.commit()
    return agent, key


def _row(key_id, endpoint, *, method="GET", ip="203.0.113.1", transport=None, tool=None, at=None):
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    row = AgentApiKeyUsageLog(
        id=uuid.uuid4(), api_key_id=key_id, endpoint=endpoint, method=method, remote_ip=ip,
        mcp_transport=transport, tool_name=tool,
    )
    if at is not None:
        row.occurred_at = at
    return row


async def _summary(Session, key_id, *, user_id, org_id, days=7):
    from app.repositories.api_key import ApiKeyRepository
    from app.routers.api_keys import api_key_usage_summary

    async with Session() as s:
        return await api_key_usage_summary(
            key_id=key_id, session=s, auth=SimpleNamespace(user_id=str(user_id)), org_id=org_id,
            repo=ApiKeyRepository(s), days=days,
        )


@pytest.mark.anyio
async def test_summary_splits_mcp_and_direct_and_ranks_paths_tools_and_addresses():
    engine, Session = await _session()
    try:
        org_id, owner = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            _agent, key = await _seed_agent_with_key(s, org_id=org_id, created_by=owner)
            _other_agent, other_key = await _seed_agent_with_key(s, org_id=org_id, created_by=owner)
            story_a, story_b = uuid.uuid4(), uuid.uuid4()
            s.add_all([
                # through the hosted MCP server (http) — two stories, folded into one path
                _row(key.id, f"/api/v2/stories/{story_a}", ip="34.64.0.1", transport="http", tool="sprintable_get_story"),
                _row(key.id, f"/api/v2/stories/{story_b}", ip="34.64.0.1", transport="http", tool="sprintable_get_story"),
                _row(key.id, "/api/v2/messages", method="POST", ip="34.64.0.1", transport="http", tool="sprintable_send_chat_message"),
                # through a local MCP (stdio) — and a direct call from the same Mac
                _row(key.id, "/api/v2/messages", method="POST", ip="198.51.100.7", transport="stdio", tool="sprintable_send_chat_message"),
                _row(key.id, f"/api/v2/stories/{story_a}", ip="198.51.100.7"),
                # outside the window · another key — neither counted
                _row(key.id, "/api/v2/old", at=datetime.now(timezone.utc) - timedelta(days=30)),
                _row(other_key.id, "/api/v2/other"),
            ])
            await s.commit()

        got = await _summary(Session, key.id, user_id=owner, org_id=org_id)
        assert (got.total, got.direct, got.via_mcp) == (5, 1, 4)
        assert got.via_mcp_by_transport == {"http": 3, "stdio": 1}
        assert [(p.method, p.path, p.count, p.via_mcp) for p in got.top_paths] == [
            ("GET", "/api/v2/stories/{id}", 3, 2),
            ("POST", "/api/v2/messages", 2, 2),
        ]
        assert [(t.tool, t.count) for t in got.top_tools] == [("sprintable_get_story", 2), ("sprintable_send_chat_message", 2)]
        assert [(a.remote_ip, a.count, a.via_mcp) for a in got.top_remote_ips] == [("34.64.0.1", 3, 3), ("198.51.100.7", 2, 1)]

        wide = await _summary(Session, key.id, user_id=owner, org_id=org_id, days=90)
        assert (wide.total, wide.direct, wide.days) == (6, 2, 90)
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_summary_of_an_unused_key_is_all_zero():
    engine, Session = await _session()
    try:
        org_id, owner = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            _agent, key = await _seed_agent_with_key(s, org_id=org_id, created_by=owner)
        got = await _summary(Session, key.id, user_id=owner, org_id=org_id)
        assert (got.total, got.direct, got.via_mcp, got.via_mcp_by_transport) == (0, 0, 0, {})
        assert (got.top_paths, got.top_tools, got.top_remote_ips) == ([], [], [])
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_summary_is_refused_to_a_stranger_in_the_org_and_to_another_org():
    """The same gate as the row list — neither a member of the org who is not the creator or an owner/admin, nor another org."""
    from fastapi import HTTPException

    engine, Session = await _session()
    try:
        org_id, owner = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            _agent, key = await _seed_agent_with_key(s, org_id=org_id, created_by=owner)
            s.add(_row(key.id, "/api/v2/stories", ip="198.51.100.7"))
            await s.commit()
        for user_id, caller_org in ((uuid.uuid4(), org_id), (uuid.uuid4(), uuid.uuid4())):
            with pytest.raises(HTTPException) as ei:
                await _summary(Session, key.id, user_id=user_id, org_id=caller_org)
            assert ei.value.status_code in (403, 404)
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_summary_of_an_unknown_key_is_404():
    from fastapi import HTTPException

    engine, Session = await _session()
    try:
        with pytest.raises(HTTPException) as ei:
            await _summary(Session, uuid.uuid4(), user_id=uuid.uuid4(), org_id=uuid.uuid4())
        assert ei.value.status_code == 404
    finally:
        await _drop_all(engine)
