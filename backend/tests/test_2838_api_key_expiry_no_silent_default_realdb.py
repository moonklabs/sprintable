"""story #2838(PO AC 확定 2026-08-20) — 에이전트 API 키 발급 UI에 만료 선택이 없어 90일이
몰래 각인되던 결함(실사고: 유나 키, 생성+정확히 90일 만료로 세션 6시간 침묵).

의도-전달-저장 3층 그라운딩이 잡은 각인 지점: `ApiKeyRepository.create()`가 "호출자가 안
정함"과 "호출자가 명시적으로 무만료를 원함"을 둘 다 `expires_at=None`으로 뭉개 90일 기본값을
씌웠다. fix는 sentinel(`_UNSET`)로 이 둘을 구분 — 인자 자체를 안 준 내부 호출부(recruit_
service/org_agent/team_members 등, 이 스토리 스코프 밖)는 옛 90일 기본 동작 무회귀, 발급 UI
경유(명시 `None` 전달)는 그 무만료 의도를 그대로 존중한다.

AC②(rotate 승계)도 같은 뿌리 — `rotate()`가 항상 `expires_at=None`으로 `create()`를 불러
회전마다 90일이 재각인됐다. 이제 원 키의 expires_at을 그대로 승계(무만료→무만료·만료 키→같은
시각)한다.

AC①(서버 계약 필수화)은 `CreateApiKeyRequest.expires_at` 기본값 제거로 스키마 레벨에서 고정
— 필드 생략 시 422(ValidationError)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_agent(session):
    from sqlalchemy import text as _text
    from app.models.team import TeamMember

    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    await session.execute(_text("SET session_replication_role = replica"))
    agent = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="테스트 에이전트", role="member",
    )
    session.add(agent)
    await session.flush()
    await session.commit()
    return agent.id


_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


# ── ①서버 계약 필수화 — 스키마 레벨(실PG 불요, 빠름) ──────────────────────────
def test_create_api_key_request_missing_expires_at_rejected():
    from app.schemas.api_key import CreateApiKeyRequest

    with pytest.raises(ValidationError, match="expires_at"):
        CreateApiKeyRequest(scope=["stories"])


def test_create_api_key_request_explicit_null_accepted():
    from app.schemas.api_key import CreateApiKeyRequest

    req = CreateApiKeyRequest(scope=["stories"], expires_at=None)
    assert req.expires_at is None


def test_create_api_key_request_explicit_date_accepted():
    from app.schemas.api_key import CreateApiKeyRequest

    dt = datetime.now(timezone.utc) + timedelta(days=30)
    req = CreateApiKeyRequest(scope=["stories"], expires_at=dt)
    assert req.expires_at == dt


# ── repo.create() — _UNSET vs 명시 None 구분 ─────────────────────────────────
@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_create_without_expires_at_arg_rejected_realdb():
    """PO AC 정정(2026-08-20) — sentinel 초판은 "인자 안 줌"에 옛 90일 기본값을 여전히
    내려줬는데, 그 경로가 정확히 team_members.py/org_agent.py/recruit_service.py 셋의
    실호출부(diff 밖 grep으로 적발, 실사고의 유력 발급 경로 그 자체)였다. 이제 필수 kwarg라
    인자를 안 주면 TypeError — repo 층이 침묵을 구조로 거부한다(90일 기본값 자체가 없음)."""
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            with pytest.raises(TypeError):
                await repo.create(team_member_id=agent_id, scope=["stories"])  # expires_at 누락
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_create_explicit_none_stores_null_no_90day_override_realdb():
    """실사고 재현 반증(양성대조): 발급 UI 경유(명시 expires_at=None)는 90일로 되돌아가면 안
    된다 — 이게 #2838이 고치는 병 그 자체."""
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            key, _plaintext = await repo.create(team_member_id=agent_id, scope=["stories"], expires_at=None)
            await s.commit()

            assert key.expires_at is None
    finally:
        await engine.dispose()


# ── AC② rotate() 승계 ────────────────────────────────────────────────────────
@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_rotate_inherits_no_expiry_realdb():
    """무만료 키를 회전해도 새 키가 여전히 무만료여야 한다(이전엔 항상 90일 재각인됐다)."""
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            old_key, _pt = await repo.create(team_member_id=agent_id, scope=["stories"], expires_at=None)
            await s.commit()

            result = await repo.rotate(old_key.id)
            await s.commit()
            assert result is not None
            new_key, _pt2 = result
            assert new_key.expires_at is None
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_rotate_inherits_existing_expiry_datetime_realdb():
    """만료 시각이 찍힌 키를 회전하면 새 키도 «같은» 만료 시각을 물려받아야 한다(연장·단축 둘 다
    아님 — 회전이 수명을 침묵으로 바꾸지 않는다)."""
    from app.repositories.api_key import ApiKeyRepository

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            repo = ApiKeyRepository(s)
            fixed_expiry = datetime.now(timezone.utc) + timedelta(days=17)
            old_key, _pt = await repo.create(team_member_id=agent_id, scope=["stories"], expires_at=fixed_expiry)
            await s.commit()

            result = await repo.rotate(old_key.id)
            await s.commit()
            assert result is not None
            new_key, _pt2 = result
            assert new_key.expires_at == fixed_expiry
    finally:
        await engine.dispose()


# ── AC④ — diff 밖 grep으로 적발된 세 내부 발급 경로가 실제로 expires_at=None을 명시
# 전달하는지 실증(페드루 PO 리뷰 정정, 유나군 키의 유력 발급 경로가 정확히 이 축). ───────────
@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_recruit_service_create_branch_issues_no_expiry_realdb():
    """recruit_service.py::_rotate_or_create_key — 활성 키가 없는 신규 채용 분기(create 경로)가
    expires_at=None을 명시하는지. 실사고(유나 키)의 유력 발급 경로가 정확히 여기."""
    from app.services.recruit_service import _rotate_or_create_key

    engine, Session = await _session()
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s)
            key, _plaintext = await _rotate_or_create_key(s, agent_id=agent_id, scope=["stories"])
            await s.commit()

            assert key.expires_at is None
    finally:
        await engine.dispose()
