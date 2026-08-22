"""story #2944(PO 정책 확定 2026-08-22) — 「발급=교체」 통일: `POST /agents/{agent_id}/api-keys`가
예전엔 기존 활성 키 확認 없이 무조건 신규 발급이라 활성 키 N개가 합법으로 생겼다(카디르 #3373
HIGH 발견 → dev DB 실측: 135 agent 중 2건 다건, 둘 다 "몇 주~몇 달 뒤 구키를 잊고 재발급" 시그니처,
그중 1건은 scope=None(무제한) 신규키+구 narrow 키 공존).

처방: `create_agent_api_key`가 이제 신규 발급 前 `ApiKeyRepository.revoke_all_active()`로 그
agent의 활성 키 전량을 원자적으로(단일 UPDATE...RETURNING) revoke한다 — 단일/다중 키 모두 동일
코드 경로(story #2941의 MultipleResultsFound 재발 클래스를 원천 차단하는 것과 같은 패턴).
FE(agent-api-key-manager.tsx)는 이미 이 의도(활성 키 있으면 revoke-확認 다이얼로그)로 설계돼
있었다 — 서버가 이제 그 의도를 원자적으로 강제한다.

2941/2939의 다중 키 방어(합집합 표시·전량 UPDATE 재동기화)는 정책과 무관하게 유지(과거 데이터·
엣지 케이스 대응)."""
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


async def _bypass_fk(session) -> None:
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


async def _seed_agent(session):
    from app.models.team import TeamMember
    await _bypass_fk(session)
    member = TeamMember(
        id=uuid.uuid4(), org_id=uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
        name="2944 Test Agent", role="member", is_active=True,
    )
    session.add(member)
    await session.flush()
    return member.id


# ── repo.revoke_all_active() — 단위 ─────────────────────────────────────────


@pytest.mark.anyio
async def test_revoke_all_active_revokes_single_key():
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            key, _pt = await repo.create(team_member_id=agent_id, scope=["read"], expires_at=None)
            await s.commit()

            revoked_ids = await repo.revoke_all_active(agent_id)
            await s.commit()
            assert revoked_ids == [key.id]

            fresh = await repo.get(key.id)
            assert fresh.revoked_at is not None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(__import__("app.core.database", fromlist=["Base"]).Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_all_active_revokes_multiple_keys_no_crash():
    """카디르 HIGH 재발견 클래스 — MultipleResultsFound가 아니라 전량 RETURNING이라 다건도 안전."""
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            key_a, _ = await repo.create(team_member_id=agent_id, scope=["read"], expires_at=None)
            key_b, _ = await repo.create(team_member_id=agent_id, scope=None, expires_at=None)
            await s.commit()

            revoked_ids = await repo.revoke_all_active(agent_id)
            await s.commit()
            assert set(revoked_ids) == {key_a.id, key_b.id}

            fresh_a = await repo.get(key_a.id)
            fresh_b = await repo.get(key_b.id)
            assert fresh_a.revoked_at is not None
            assert fresh_b.revoked_at is not None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(__import__("app.core.database", fromlist=["Base"]).Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_all_active_no_active_keys_is_noop():
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            await s.commit()
            repo = ApiKeyRepository(s)
            revoked_ids = await repo.revoke_all_active(agent_id)
            assert revoked_ids == []
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(__import__("app.core.database", fromlist=["Base"]).Base.metadata.drop_all)
        await engine.dispose()


# ── HTTP 엔드포인트 — direct-API 경로 재현(FE 게이트 우회 시나리오) ────────────


async def _client_and_session():
    import app.models  # noqa: F401
    from app.main import app
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    org_id = uuid.uuid4()
    actor_id = uuid.uuid4()

    async def override_db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def override_auth():
        return AuthContext(user_id=str(actor_id), email=None, claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id))

    async def override_org_id():
        return org_id

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    app.dependency_overrides[get_verified_org_id] = override_org_id

    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return client, Session, app, org_id, actor_id, engine


@pytest.mark.anyio
async def test_direct_api_reissue_revokes_prior_key_end_to_end():
    """FE 게이트를 안 거치는 직접 API 호출(dev 실측 시나리오 그대로) — 이미 활성 키가 있는
    agent에게 일반 발급 엔드포인트를 다시 호출하면, 새 키만 활성으로 남고 구키는 revoke돼야
    한다(예전엔 둘 다 활성으로 남았다 — 미르코/hermes-test 실사고 그대로)."""
    from app.models.team import TeamMember
    from app.repositories.api_key import ApiKeyRepository

    client, Session, app, org_id, actor_id, engine = await _client_and_session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
                name="Reissue Test Agent", role="member", is_active=True, created_by=actor_id,
            )
            s.add(member)
            await s.commit()
            agent_id = member.id

            repo = ApiKeyRepository(s)
            old_key, _pt = await repo.create(
                team_member_id=agent_id, scope=["read", "write"], expires_at=None
            )
            await s.commit()
            old_key_id = old_key.id

        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/api-keys",
                json={"scope": ["stories", "tasks"], "expires_at": None},
            )
        assert resp.status_code == 201, resp.text
        new_key_id = uuid.UUID(resp.json()["id"])

        async with Session() as s:
            repo = ApiKeyRepository(s)
            refreshed_old = await repo.get(old_key_id)
            refreshed_new = await repo.get(new_key_id)
            assert refreshed_old.revoked_at is not None, "구키가 revoke 안 됨 — #2944 회귀"
            assert refreshed_new.revoked_at is None
            assert refreshed_new.scope == ["stories", "tasks"]

            active = [k for k in await repo.list_by_member(agent_id) if k.revoked_at is None]
            assert len(active) == 1, f"활성 키가 정확히 1개여야 하는데 {len(active)}개"
    finally:
        app.dependency_overrides.clear()
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_direct_api_reissue_revokes_multiple_prior_keys_end_to_end():
    """dev 실측과 동형 — 이미 다건 활성 키가 있는 상태(카디르 발견 시나리오)에서 재발급하면
    기존 것 전부 revoke되고 신규 1개만 남는다."""
    from app.models.team import TeamMember
    from app.repositories.api_key import ApiKeyRepository

    client, Session, app, org_id, actor_id, engine = await _client_and_session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
                name="Multi Reissue Test Agent", role="member", is_active=True, created_by=actor_id,
            )
            s.add(member)
            await s.commit()
            agent_id = member.id

            repo = ApiKeyRepository(s)
            old_a, _ = await repo.create(team_member_id=agent_id, scope=["read"], expires_at=None)
            old_b, _ = await repo.create(team_member_id=agent_id, scope=None, expires_at=None)
            await s.commit()
            old_ids = {old_a.id, old_b.id}

        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/api-keys",
                json={"scope": ["stories"], "expires_at": None},
            )
        assert resp.status_code == 201, resp.text

        async with Session() as s:
            repo = ApiKeyRepository(s)
            keys = await repo.list_by_member(agent_id)
            active = [k for k in keys if k.revoked_at is None]
            revoked = [k for k in keys if k.revoked_at is not None]
            assert len(active) == 1
            assert {k.id for k in revoked} == old_ids
    finally:
        app.dependency_overrides.clear()
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_direct_api_first_issuance_unaffected_when_no_prior_key():
    """무회귀: 첫 발급(활성 키 0개)은 기존 동작 그대로 — revoke 대상 없음, 정상 201."""
    from app.models.team import TeamMember
    from app.repositories.api_key import ApiKeyRepository

    client, Session, app, org_id, actor_id, engine = await _client_and_session()
    try:
        async with Session() as s:
            await _bypass_fk(s)
            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=uuid.uuid4(), type="agent",
                name="First Issuance Test Agent", role="member", is_active=True, created_by=actor_id,
            )
            s.add(member)
            await s.commit()
            agent_id = member.id

        async with client as c:
            resp = await c.post(
                f"/api/v2/agents/{agent_id}/api-keys",
                json={"scope": ["stories"], "expires_at": None},
            )
        assert resp.status_code == 201, resp.text

        async with Session() as s:
            repo = ApiKeyRepository(s)
            active = [k for k in await repo.list_by_member(agent_id) if k.revoked_at is None]
            assert len(active) == 1
    finally:
        app.dependency_overrides.clear()
        async with engine.begin() as conn:
            from app.core.database import Base
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
