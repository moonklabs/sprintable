"""story #2087([BE] 에이전트 API 키 사용 이력 감사 트레일 부재) — 실PG 검증.

`record_api_key_usage`(write, 스로틀 없음)·`list_api_key_usage`(read, 최신순+limit)·
`_resolve_api_key` 성공 경로가 실제로 usage log를 남기는지·GET /api/v2/api-keys/{id}/logs
엔드포인트가 죽은 FE 경로를 실제로 살렸는지(+cross-org 소유권 거부)를 실PG로 검증한다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


async def _seed_agent(session, *, org_id: uuid.UUID | None = None):
    from app.models.team import TeamMember

    await _bypass_fk(session)
    member = TeamMember(
        id=uuid.uuid4(), org_id=org_id or uuid.uuid4(), project_id=uuid.uuid4(), type="agent",
        name="2087 Test Agent", role="member", is_active=True,
    )
    session.add(member)
    await session.flush()
    return member


async def _drop_all(engine) -> None:
    from app.core.database import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


class _PatchedSessionFactory:
    """story #2836 선례와 동일 — record_api_key_usage/_resolve_api_key가 내부에서 쓰는
    전역 `app.core.database.async_session_factory`는 최초 사용 시점의 이벤트루프에
    바인딩된다. pytest-asyncio가 테스트 함수마다 새 루프를 쓰므로, 이 전역을 이 테스트의
    per-test 엔진 sessionmaker로 임시 교체해야 "attached to a different loop" 없이 돈다."""

    def __init__(self, session_factory):
        self._session_factory = session_factory
        self._orig = None

    async def __aenter__(self):
        import app.core.database as _dbmod
        self._orig = _dbmod.async_session_factory
        _dbmod.async_session_factory = self._session_factory
        return self

    async def __aexit__(self, *exc):
        import app.core.database as _dbmod
        _dbmod.async_session_factory = self._orig


# ── record_api_key_usage / list_api_key_usage — 단위 ────────────────────────


@pytest.mark.anyio
async def test_record_api_key_usage_writes_a_row_with_expected_fields():
    from app.services.agent_api_key_usage import list_api_key_usage, record_api_key_usage

    engine, Session = await _session()
    try:
        api_key_id = uuid.uuid4()
        org_id = uuid.uuid4()
        member_id = uuid.uuid4()

        class _FakeClient:
            host = "203.0.113.9"

        class _FakeRequest:
            url = type("_U", (), {"path": "/api/v2/agents/x/stream"})()
            method = "GET"
            client = _FakeClient()

        async with _PatchedSessionFactory(Session):
            await record_api_key_usage(
                api_key_id=api_key_id, org_id=org_id, member_id=member_id, request=_FakeRequest(),
            )

        async with Session() as s:
            rows = await list_api_key_usage(s, api_key_id)
        assert len(rows) == 1
        row = rows[0]
        assert row.api_key_id == api_key_id
        assert row.org_id == org_id
        assert row.member_id == member_id
        assert row.endpoint == "/api/v2/agents/x/stream"
        assert row.method == "GET"
        assert row.remote_ip == "203.0.113.9"
        assert row.occurred_at is not None
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_record_api_key_usage_handles_missing_request_gracefully():
    """직접호출(테스트·`_resolve_api_key`의 request=None 기본값)에서도 실패하면 안 된다 —
    인증 자체를 절대 막지 않는다는 계약(fail-silent) 그대로."""
    from app.services.agent_api_key_usage import list_api_key_usage, record_api_key_usage

    engine, Session = await _session()
    try:
        api_key_id = uuid.uuid4()
        async with _PatchedSessionFactory(Session):
            await record_api_key_usage(api_key_id=api_key_id, org_id=None, member_id=None, request=None)

        async with Session() as s:
            rows = await list_api_key_usage(s, api_key_id)
        assert len(rows) == 1
        assert rows[0].endpoint == "unknown"
        assert rows[0].method == "unknown"
        assert rows[0].remote_ip is None
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_list_api_key_usage_is_not_throttled_every_call_recorded():
    """last_used_at(5분 스로틀, story #2457)과 달리 이 원장은 완전성이 목적 — 짧은 간격
    연속 호출도 전부 남아야 한다."""
    from app.services.agent_api_key_usage import list_api_key_usage, record_api_key_usage

    engine, Session = await _session()
    try:
        api_key_id = uuid.uuid4()
        async with _PatchedSessionFactory(Session):
            for _ in range(5):
                await record_api_key_usage(api_key_id=api_key_id, org_id=None, member_id=None, request=None)

        async with Session() as s:
            rows = await list_api_key_usage(s, api_key_id)
        assert len(rows) == 5
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_list_api_key_usage_orders_newest_first_and_respects_limit():
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog
    from app.services.agent_api_key_usage import list_api_key_usage

    engine, Session = await _session()
    try:
        api_key_id = uuid.uuid4()
        async with Session() as s:
            base = datetime(2026, 1, 1, tzinfo=timezone.utc)
            for i in range(3):
                s.add(AgentApiKeyUsageLog(
                    id=uuid.uuid4(), api_key_id=api_key_id, org_id=None, member_id=None,
                    endpoint=f"/api/v2/x/{i}", method="GET", remote_ip=None,
                    occurred_at=base.replace(hour=i),
                ))
            await s.commit()

        async with Session() as s:
            rows = await list_api_key_usage(s, api_key_id, limit=2)
        assert len(rows) == 2
        assert [r.endpoint for r in rows] == ["/api/v2/x/2", "/api/v2/x/1"], "최신순이어야 함"
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_list_api_key_usage_scoped_to_the_given_key_only():
    from app.services.agent_api_key_usage import list_api_key_usage, record_api_key_usage

    engine, Session = await _session()
    try:
        key_a, key_b = uuid.uuid4(), uuid.uuid4()
        async with _PatchedSessionFactory(Session):
            await record_api_key_usage(api_key_id=key_a, org_id=None, member_id=None, request=None)
            await record_api_key_usage(api_key_id=key_b, org_id=None, member_id=None, request=None)

        async with Session() as s:
            rows_a = await list_api_key_usage(s, key_a)
        assert len(rows_a) == 1
        assert rows_a[0].api_key_id == key_a
    finally:
        await _drop_all(engine)


# ── _resolve_api_key 성공 경로 통합 — usage log가 실제로 남는지 ────────────────


@pytest.mark.anyio
async def test_resolve_api_key_success_records_usage_log():
    from app.dependencies.auth import _resolve_api_key
    from app.services.agent_api_key_usage import list_api_key_usage

    engine, Session = await _session()
    try:
        async with Session() as s:
            member = await _seed_agent(s)
            from app.repositories.api_key import ApiKeyRepository
            repo = ApiKeyRepository(s)
            key, plaintext = await repo.create(team_member_id=member.id, scope=["read"], expires_at=None)
            # member_id 미러(dual-write, E-MEMBER-SSOT) — repo.create가 member_id를 채우는지
            # 이 테스트 스코프 밖이라(회귀는 다른 테스트가 커버) 직접 채워 legacy 경로로만 검증.
            await s.commit()

        async with Session() as s:
            class _FakeClient:
                host = "198.51.100.7"

            class _FakeRequest:
                url = type("_U", (), {"path": "/api/v2/agents/stream"})()
                method = "GET"
                client = _FakeClient()

            async with _PatchedSessionFactory(Session):
                await _resolve_api_key(plaintext, s, request=_FakeRequest())

        async with Session() as s:
            rows = await list_api_key_usage(s, key.id)
        assert len(rows) == 1
        assert rows[0].endpoint == "/api/v2/agents/stream"
        assert rows[0].remote_ip == "198.51.100.7"
    finally:
        await _drop_all(engine)


@pytest.mark.anyio
async def test_resolve_api_key_failure_does_not_record_usage_log():
    """401(존재하지 않는 키)은 사용 이력이 아니다 — agent_auth_failure 원장의 몫."""
    from fastapi import HTTPException

    from app.dependencies.auth import _resolve_api_key
    from app.services.agent_api_key_usage import list_api_key_usage

    engine, Session = await _session()
    try:
        # story OB-4(#1720) 규율 — sk_live_ 접두+긴 무작위 문자열은 GitHub push protection이
        # 실 시크릿 형태로 오탐한다(가짜여도). 런타임 조립으로 리터럴 매치를 피한다.
        _fake_key = "sk_live_" + "nonexistent" + "0" * 13
        async with Session() as s, _PatchedSessionFactory(Session):
            with pytest.raises(HTTPException):
                await _resolve_api_key(_fake_key, s)

        async with Session() as s:
            # 존재하지 않는 키라 api_key_id 자체를 모르므로, 테이블 전체가 비어 있어야 함.
            from sqlalchemy import select
            from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog
            count = (await s.execute(select(AgentApiKeyUsageLog))).scalars().all()
        assert count == []
    finally:
        await _drop_all(engine)
