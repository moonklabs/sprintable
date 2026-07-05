"""E-RECRUIT S16 (story 561fd294, CRITICAL 보안): POST /api-keys/rotate cross-org IDOR fix
실 Postgres 검증.

핵심: 타 org 소속 agent의 api_key_id로 rotate 시도 시 ①HTTPException(403/404)으로 거부되고
②실제 DB mutation이 전혀 일어나지 않는지(피해자 org의 키가 그대로 active인지 — "가드가 예외를
던지는 것"과 "그 예외가 실제로 write를 막는 것"은 다른 주장이라 직접 확認)."""
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_cross_org_rotate_rejected_and_victim_key_untouched():
    from types import SimpleNamespace
    from sqlalchemy import select, text as _text
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey
    from app.repositories.api_key import ApiKeyRepository
    from app.routers.api_keys import rotate_api_key
    from app.schemas.api_key import RotateApiKeyRequest
    from fastapi import HTTPException

    engine, Session = await _session()
    try:
        victim_org_id, attacker_org_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            victim_agent = TeamMember(
                id=uuid.uuid4(), org_id=victim_org_id, project_id=project_id, type="agent",
                name="Victim Agent", role="member",
            )
            s.add(victim_agent)
            await s.flush()
            key, _plaintext = await ApiKeyRepository(s).create(
                team_member_id=victim_agent.id, scope=["stories"]
            )
            victim_key_id, original_hash = key.id, key.key_hash
            await s.commit()

        # 공격자: attacker_org_id(피해자와 다른 org)로 인증된 채, 피해자 org의 api_key_id를
        # 안다는 이유만으로 rotate 시도.
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            with pytest.raises(HTTPException) as ei:
                await rotate_api_key(
                    RotateApiKeyRequest(api_key_id=victim_key_id),
                    auth=SimpleNamespace(user_id=str(uuid.uuid4())),
                    org_id=attacker_org_id,
                    repo=ApiKeyRepository(s),
                    session=s,
                )
            assert ei.value.status_code in (403, 404)
            await s.rollback()

        # 실제 DB mutation 없었는지 — 피해자 키가 그대로 active·원본 hash 유지.
        async with Session() as s:
            victim_key = (await s.execute(
                select(ApiKey).where(ApiKey.id == victim_key_id)
            )).scalar_one()
            assert victim_key.revoked_at is None
            assert victim_key.key_hash == original_hash

            all_keys = (await s.execute(
                select(ApiKey).where(ApiKey.team_member_id == victim_agent.id)
            )).scalars().all()
            assert len(all_keys) == 1  # 공격자가 "새 키 발급"도 못 했어야 함
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
