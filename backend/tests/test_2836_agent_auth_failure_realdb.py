"""story #2836([결함·관측], 실사고 — 유나 세션 6시간+ 침묵·미르코 revoke 사례) — 에이전트 API키
401 인증실패 원장 실PG 검증.

AC④(원인 판별, 추측 금지): expired=행 있고 expires_at 도과·revoked=revoked_at 세팅·invalid=
해당 prefix 행 없음. AC⑤(시크릿 규율): key_prefix만 저장, raw 값은 절대 안 남는다(모델 자체가
그 컬럼을 안 가짐 — 구조적 보장). AC①/⑥(임계): AUTH_FAILURE_THRESHOLD회 도달 전엔 presence
무변화, 도달 순간에만 agent_status="auth_failed"로 갱신(매 실패마다 덮어쓰지 않음).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    import app.models  # noqa: F401

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent_key(session, *, revoked=False, expired=False):
    """정확히 app/repositories/api_key.py::_generate_key와 동일 규약으로 raw_key/prefix/hash를
    만든다(발명 0 — 실 발급 경로와 다른 규약을 테스트가 쓰면 그 자체가 거짓 초록)."""
    from datetime import datetime, timedelta, timezone

    from app.repositories.api_key import _generate_key
    from app.models.api_key import ApiKey
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    member = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent", is_active=True)
    session.add(member)
    await session.commit()
    # 0075 1:1 anchor(member.id == team_member.id) — ApiKey.team_member_id FK 충족용.
    session.add(TeamMember(id=member.id, org_id=org.id, project_id=project.id, type="agent", name="Agent"))
    await session.commit()

    plaintext, prefix, key_hash = _generate_key()
    now = datetime.now(timezone.utc)
    key = ApiKey(
        id=uuid.uuid4(), team_member_id=member.id, member_id=member.id,
        key_prefix=prefix, key_hash=key_hash,
        revoked_at=now if revoked else None,
        expires_at=(now - timedelta(days=1)) if expired else None,
    )
    session.add(key)
    await session.commit()
    return {
        "org_id": org.id, "project_id": project.id, "member_id": member.id,
        "raw_key": plaintext, "prefix": prefix,
    }


async def _failures_for(session, member_id=None):
    from sqlalchemy import select

    from app.models.agent_auth_failure import AgentAuthFailure

    q = select(AgentAuthFailure)
    if member_id is not None:
        q = q.where(AgentAuthFailure.member_id == member_id)
    return (await session.execute(q)).scalars().all()


@pytest.mark.anyio
async def test_invalid_key_records_reason_invalid_no_org_attribution():
    from app.services.agent_auth_failure import record_auth_failure

    engine, Session = await _session_factory()
    try:
        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            await record_auth_failure("sk_live_" + "a" * 64)  # 실존하지 않는 키.
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            rows = await _failures_for(s)
            assert len(rows) == 1
            assert rows[0].reason == "invalid"
            assert rows[0].org_id is None
            assert rows[0].api_key_id is None
            assert rows[0].member_id is None
            assert rows[0].key_prefix == "sk_live_" + "a" * 8
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_api_key_401_path_actually_records_failure():
    """엔드투엔드 배선 확認 — `record_auth_failure`를 직접 부르는 게 아니라 auth.py의 실 401
    경로(`_resolve_api_key`)가 그걸 호출하는지 증명(단위 테스트만으론 배선 누락을 못 잡는다)."""
    from app.dependencies.auth import _resolve_api_key
    from fastapi import HTTPException

    engine, Session = await _session_factory()
    try:
        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            async with Session() as s:
                with pytest.raises(HTTPException) as exc_info:
                    await _resolve_api_key("sk_live_" + "b" * 64, s)
                assert exc_info.value.status_code == 401
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            rows = await _failures_for(s)
            assert len(rows) == 1
            assert rows[0].reason == "invalid"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_expired_key_records_reason_expired_with_attribution():
    from app.services.agent_auth_failure import record_auth_failure

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, expired=True)

        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            await record_auth_failure(seeded["raw_key"])
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            rows = await _failures_for(s, seeded["member_id"])
            assert len(rows) == 1
            assert rows[0].reason == "expired"
            assert rows[0].org_id == seeded["org_id"]
            assert rows[0].key_prefix == seeded["prefix"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoked_key_records_reason_revoked():
    from app.services.agent_auth_failure import record_auth_failure

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, revoked=True)

        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            await record_auth_failure(seeded["raw_key"])
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            rows = await _failures_for(s, seeded["member_id"])
            assert len(rows) == 1
            assert rows[0].reason == "revoked"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoked_and_expired_both_true_revoked_wins():
    """설계 결정 고정 — 둘 다 참이면 revoked(더 의도적인 상태)가 우선."""
    from app.services.agent_auth_failure import record_auth_failure

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, revoked=True, expired=True)

        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            await record_auth_failure(seeded["raw_key"])
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            rows = await _failures_for(s, seeded["member_id"])
            assert rows[0].reason == "revoked"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_malformed_key_is_skipped_no_row():
    """⑤ 부속 — 우리 키 형식조차 아니면(prefix 못 뽑음) 원장 대상 밖(외부 스캐너 소음 방지)."""
    from app.services.agent_auth_failure import record_auth_failure

    engine, Session = await _session_factory()
    try:
        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            await record_auth_failure("not-even-close-to-a-key")
        finally:
            _dbmod.async_session_factory = _orig

        async with Session() as s:
            assert await _failures_for(s) == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_threshold_crossing_sets_agent_status_not_before():
    """AC①/⑥ — 임계(AUTH_FAILURE_THRESHOLD) 미만은 presence 무변화, 도달 순간에만 auth_failed."""
    from app.models.member import AgentProjectProfile
    from app.services.agent_auth_failure import AUTH_FAILURE_THRESHOLD, record_auth_failure

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_agent_key(s, revoked=True)
            s.add(AgentProjectProfile(
                id=uuid.uuid4(), member_id=seeded["member_id"], project_id=seeded["project_id"],
                agent_status="online",
            ))
            await s.commit()

        import app.core.database as _dbmod
        _orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = Session
        try:
            for _ in range(AUTH_FAILURE_THRESHOLD - 1):
                await record_auth_failure(seeded["raw_key"])

            async with Session() as s:
                from sqlalchemy import select
                prof = (await s.execute(
                    select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
                )).scalar_one()
                assert prof.agent_status == "online", "임계 미달 — presence 그대로여야 함"

            await record_auth_failure(seeded["raw_key"])  # 정확히 임계 도달.

            async with Session() as s:
                from sqlalchemy import select
                prof = (await s.execute(
                    select(AgentProjectProfile).where(AgentProjectProfile.member_id == seeded["member_id"])
                )).scalar_one()
                assert prof.agent_status == "auth_failed"
        finally:
            _dbmod.async_session_factory = _orig
    finally:
        await engine.dispose()
