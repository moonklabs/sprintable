"""story #2087 — GET /api/v2/api-keys/{key_id}/logs 엔드포인트(죽은 FE 경로 소생) 실PG 검증.

story 561fd294(rotate cross-org IDOR)와 동일 원칙 — 자매 엔드포인트와 같은
``assert_agent_owner`` 가드를 새 read 엔드포인트에도 반드시 태워야 한다. 이 테스트는
①owner 정상 조회 ②cross-org 시도 거부+실제로 남의 로그가 안 새는지 둘 다 확認한다."""
from __future__ import annotations

import os
import uuid

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


async def _seed_agent_with_key(session, *, org_id: uuid.UUID, project_id: uuid.UUID, created_by: uuid.UUID):
    from sqlalchemy import text as _text
    from app.models.team import TeamMember
    from app.repositories.api_key import ApiKeyRepository

    await session.execute(_text("SET session_replication_role = replica"))
    agent = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="2087 Owner Test Agent", role="member", created_by=created_by,
    )
    session.add(agent)
    await session.flush()
    key, _plaintext = await ApiKeyRepository(session).create(
        team_member_id=agent.id, scope=["read"], expires_at=None,
    )
    await session.commit()
    return agent, key


@pytest.mark.anyio
async def test_owner_can_list_own_key_usage_logs():
    from types import SimpleNamespace

    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog
    from app.repositories.api_key import ApiKeyRepository
    from app.routers.api_keys import list_api_key_logs

    engine, Session = await _session()
    try:
        org_id, project_id, owner_user_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            agent, key = await _seed_agent_with_key(
                s, org_id=org_id, project_id=project_id, created_by=owner_user_id,
            )
            s.add(AgentApiKeyUsageLog(
                id=uuid.uuid4(), api_key_id=key.id, org_id=org_id, member_id=agent.id,
                endpoint="/api/v2/agents/stream", method="GET", remote_ip="203.0.113.1",
            ))
            await s.commit()

        async with Session() as s:
            result = await list_api_key_logs(
                key_id=key.id,
                session=s,
                auth=SimpleNamespace(user_id=str(owner_user_id)),
                org_id=org_id,
                repo=ApiKeyRepository(s),
                limit=50,
            )
        assert len(result) == 1
        assert result[0].api_key_id == key.id
        assert result[0].endpoint == "/api/v2/agents/stream"
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_cross_org_caller_cannot_list_another_orgs_key_logs():
    """story 561fd294와 동형 — org_id dependency는 있어도 ownership 검증을 빼먹으면 같은
    IDOR이 read 표면에도 그대로 재현된다."""
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog
    from app.repositories.api_key import ApiKeyRepository
    from app.routers.api_keys import list_api_key_logs

    engine, Session = await _session()
    try:
        victim_org_id, attacker_org_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            _victim_agent, victim_key = await _seed_agent_with_key(
                s, org_id=victim_org_id, project_id=project_id, created_by=uuid.uuid4(),
            )
            s.add(AgentApiKeyUsageLog(
                id=uuid.uuid4(), api_key_id=victim_key.id, org_id=victim_org_id,
                member_id=_victim_agent.id, endpoint="/api/v2/agents/stream", method="GET",
                remote_ip="203.0.113.2",
            ))
            await s.commit()

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await list_api_key_logs(
                    key_id=victim_key.id,
                    session=s,
                    auth=SimpleNamespace(user_id=str(uuid.uuid4())),
                    org_id=attacker_org_id,
                    repo=ApiKeyRepository(s),
                    limit=50,
                )
            assert ei.value.status_code in (403, 404)
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_unknown_key_id_returns_404():
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.repositories.api_key import ApiKeyRepository
    from app.routers.api_keys import list_api_key_logs

    engine, Session = await _session()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await list_api_key_logs(
                    key_id=uuid.uuid4(),
                    session=s,
                    auth=SimpleNamespace(user_id=str(uuid.uuid4())),
                    org_id=uuid.uuid4(),
                    repo=ApiKeyRepository(s),
                    limit=50,
                )
            assert ei.value.status_code == 404
    finally:
        await _drop_all(engine)
