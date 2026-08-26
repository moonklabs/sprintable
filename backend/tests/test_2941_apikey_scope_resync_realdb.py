"""story #2941(2939-② 설계 재조사 중 발견): PATCH /agent_personas의 tool_allowlist 갱신이
ApiKey.scope(실제 매 요청 `_check_api_key_scope`로 집행되는 값)를 재동기화 안 해 표시용/
집행용 권한이 드리프트하던 갭 — `AgentPersonaRepository.update()`가 tool_allowlist를 건드릴
때 같은 세션·같은 트랜잭션에서 `ApiKeyRepository.sync_active_scope()`를 호출해 봉합.

`rotate()`(신규 키 발급)가 아니라 활성 키의 scope만 원자 갱신 — 스코프 축소가 기존 발급 키에
즉시 반영되는 게 보안 취지(호출자가 새 plaintext를 다시 받아야 하면 그 자체가 별도 마찰이라
목적에 안 맞는다, PO 방향 확定)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 컨벤션: create_all/drop_all 자체 스키마 관리 — 공유 alembic-migrated DB 오염 방지.
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


async def _bypass_fk(session) -> None:
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


@pytest.mark.anyio
async def test_patch_tool_allowlist_resyncs_active_api_key_scope():
    """핵심 회귀: PATCH(=repo.update)로 tool_allowlist를 좁히면, 발급된 활성 키의 ApiKey.scope도
    같은 값으로 즉시 바뀐다(드리프트가 실제로 봉합됐는지 직접 검증)."""
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey
    from app.repositories.agent_persona import AgentPersonaRepository

    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="Scope Resync Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()

            repo = AgentPersonaRepository(s)
            persona = await repo.create(
                org_id=org_id, project_id=project_id, agent_id=member.id, actor_id=uuid.uuid4(),
                name="Scope Resync Persona", tool_allowlist=["read", "write", "admin"],
            )
            key = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_resync",
                key_hash="fake-hash-resync", scope=["read", "write", "admin"],
            )
            s.add(key)
            await s.commit()
            persona_id, key_id = persona.id, key.id

        async with Session() as s:
            repo = AgentPersonaRepository(s)
            await repo.update(
                persona_id, org_id, project_id, uuid.uuid4(),
                tool_allowlist=["read"],  # 권한 축소
            )
            await s.commit()

        async with Session() as s:
            from sqlalchemy import select
            refreshed = (await s.execute(select(ApiKey).where(ApiKey.id == key_id))).scalar_one()
            assert refreshed.scope == ["read"], (
                f"PATCH로 tool_allowlist를 좁혔는데 실제 집행값 ApiKey.scope가 안 바뀜(드리프트 "
                f"재발) — 얻은 값: {refreshed.scope}"
            )
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_tool_allowlist_does_not_touch_revoked_key():
    """revoke된(옛) 키는 재동기화 대상이 아니다 — 활성 키만."""
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey
    from app.repositories.agent_persona import AgentPersonaRepository
    from datetime import datetime, timezone

    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="Revoked Untouched Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()

            repo = AgentPersonaRepository(s)
            persona = await repo.create(
                org_id=org_id, project_id=project_id, agent_id=member.id, actor_id=uuid.uuid4(),
                name="Revoked Untouched Persona", tool_allowlist=["read"],
            )
            revoked_key = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_revoked",
                key_hash="fake-hash-revoked", scope=["old_scope_should_stay"],
                revoked_at=datetime.now(timezone.utc),
            )
            s.add(revoked_key)
            await s.commit()
            persona_id, revoked_key_id = persona.id, revoked_key.id

        async with Session() as s:
            repo = AgentPersonaRepository(s)
            await repo.update(
                persona_id, org_id, project_id, uuid.uuid4(),
                tool_allowlist=["read", "write"],
            )
            await s.commit()

        async with Session() as s:
            from sqlalchemy import select
            refreshed = (await s.execute(
                select(ApiKey).where(ApiKey.id == revoked_key_id)
            )).scalar_one()
            assert refreshed.scope == ["old_scope_should_stay"]
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_tool_allowlist_no_active_key_is_noop_not_error():
    """수기 생성 persona(recruit 이전, 키 발급 없음)에 PATCH해도 크래시하지 않는다."""
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.repositories.agent_persona import AgentPersonaRepository

    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="No Key Yet Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()

            repo = AgentPersonaRepository(s)
            persona = await repo.create(
                org_id=org_id, project_id=project_id, agent_id=member.id, actor_id=uuid.uuid4(),
                name="No Key Yet Persona",
            )
            await s.commit()
            persona_id = persona.id

        async with Session() as s:
            repo = AgentPersonaRepository(s)
            updated = await repo.update(
                persona_id, org_id, project_id, uuid.uuid4(),
                tool_allowlist=["read"],
            )
            await s.commit()
        assert updated.config["tool_allowlist"] == ["read"]
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_tool_allowlist_resyncs_all_active_keys_when_agent_has_multiple():
    """카디르 HIGH 재발견(2026-08-22): "활성 키 최대 1개"는 recruit 경로에서만 참인
    불변식 — 일반 발급 엔드포인트(POST /agents/{agent_id}/api-keys)는 기존 활성 키를
    확인 안 하고 무조건 신규 발급이라 활성 키가 합법적으로 2개 이상일 수 있다. 이 상태서
    PATCH로 권한을 축소하면 (a) 크래시 없이 (b) 두 키 전부 새 scope로 갱신돼야 한다."""
    from app.core.database import Base
    from app.models.team import TeamMember
    from app.models.api_key import ApiKey
    from app.repositories.agent_persona import AgentPersonaRepository

    engine, Session = await _session()
    try:
        org_id, project_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
                name="Multi Active Key Test Agent", role="member", is_active=True,
            )
            s.add(member)
            await s.flush()

            repo = AgentPersonaRepository(s)
            persona = await repo.create(
                org_id=org_id, project_id=project_id, agent_id=member.id, actor_id=uuid.uuid4(),
                name="Multi Active Key Persona", tool_allowlist=["read", "write", "admin"],
            )
            key_a = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_multia",
                key_hash="fake-hash-multi-a", scope=["read", "write", "admin"],
            )
            key_b = ApiKey(
                id=uuid.uuid4(), team_member_id=member.id, key_prefix="sk_live_multib",
                key_hash="fake-hash-multi-b", scope=["read", "write", "admin"],
            )
            s.add_all([key_a, key_b])
            await s.commit()
            persona_id, key_a_id, key_b_id = persona.id, key_a.id, key_b.id

        async with Session() as s:
            repo = AgentPersonaRepository(s)
            # 크래시(MultipleResultsFound → 트랜잭션 롤백) 없이 완료돼야 한다.
            await repo.update(
                persona_id, org_id, project_id, uuid.uuid4(),
                tool_allowlist=["read"],
            )
            await s.commit()

        async with Session() as s:
            from sqlalchemy import select
            refreshed_a = (await s.execute(select(ApiKey).where(ApiKey.id == key_a_id))).scalar_one()
            refreshed_b = (await s.execute(select(ApiKey).where(ApiKey.id == key_b_id))).scalar_one()
            assert refreshed_a.scope == ["read"], f"key A 미갱신: {refreshed_a.scope}"
            assert refreshed_b.scope == ["read"], f"key B 미갱신: {refreshed_b.scope}"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
