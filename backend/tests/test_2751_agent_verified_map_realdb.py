"""story #2751(설계②, PO 판정 2026-08-18) realdb 검증 — 워크포스 목록 "연결 안 됨" CTA용
배치 verified 조회(`agent_verify.get_verified_map`)가 `get_verification_state()`와 같은
정의(acked_seq >= verify_seq)로, 에이전트 수와 무관한 상수 쿼리(GROUP BY 배치)로 맞는
값을 내는지 실PG로 확認. 로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2751", slug=f"org2751-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


async def _ack(session, agent_id, seq: int) -> None:
    from app.models.agent_gateway import AgentEventCursor

    session.add(AgentEventCursor(agent_id=agent_id, acked_seq=seq))
    await session.commit()


@pytest.mark.asyncio
async def test_never_attempted_verification_returns_false():
    """이탈자(위저드에서 runtime은 골랐지만 verify 자체를 한 번도 시도 안 함) — CTA가
    잡아야 할 정확히 그 케이스, False로 나와야 한다(map에서 빠지지 않고 키 자체가 있음)."""
    from app.services.agent_verify import get_verified_map

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            result = await get_verified_map(s, [agent_id])

            assert result == {agent_id: False}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_verify_sent_but_never_acked_returns_false():
    from app.services.agent_verify import get_verified_map, start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()

            result = await get_verified_map(s, [agent_id])

            assert result == {agent_id: False}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_verify_acked_at_or_above_seq_returns_true():
    from app.services.agent_verify import get_verified_map, start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            seq = await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()
            await _ack(s, agent_id, seq)

            result = await get_verified_map(s, [agent_id])

            assert result == {agent_id: True}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_ack_below_seq_returns_false():
    """acked_seq가 있어도 최신 verify_seq보다 낮으면(재시도로 새 seq가 발급됐는데 아직
    그 새 요청은 못 ack) 미완주로 판정해야 한다."""
    from app.services.agent_verify import get_verified_map, start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            first_seq = await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()
            await _ack(s, agent_id, first_seq)
            # 재시도 — 새 verify 이벤트로 seq가 올라감(아직 ack 안 됨).
            await start_verification(s, agent_id=agent_id, org_id=org_id, project_id=project_id)
            await s.commit()

            result = await get_verified_map(s, [agent_id])

            assert result == {agent_id: False}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_batch_query_handles_multiple_agents_with_mixed_states_in_constant_queries():
    """N=3 에이전트(각기 다른 상태) — 쿼리 수가 에이전트 수에 비례하지 않는지(fan-out 금지)
    실측. `session.execute` 호출 횟수를 세어 2회(verify_seq 배치·acked_seq 배치)로 고정임을
    직접 증명한다(PO가 명시적으로 fan-out 금지를 못박은 조건 — 문서 주장이 아니라 계측)."""
    from unittest.mock import AsyncMock

    from app.services.agent_verify import get_verified_map, start_verification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            never_verified = await _seed_agent(s, org_id, project_id)
            fully_verified = await _seed_agent(s, org_id, project_id)
            seq = await start_verification(s, agent_id=fully_verified, org_id=org_id, project_id=project_id)
            await s.commit()
            await _ack(s, fully_verified, seq)
            sent_not_acked = await _seed_agent(s, org_id, project_id)
            await start_verification(s, agent_id=sent_not_acked, org_id=org_id, project_id=project_id)
            await s.commit()

            original_execute = s.execute
            call_count = {"n": 0}

            async def _counting_execute(*args, **kwargs):
                call_count["n"] += 1
                return await original_execute(*args, **kwargs)

            s.execute = AsyncMock(side_effect=_counting_execute)

            result = await get_verified_map(s, [never_verified, fully_verified, sent_not_acked])

            assert call_count["n"] == 2  # 에이전트 수(3)와 무관 — 상수 쿼리.
            assert result == {
                never_verified: False,
                fully_verified: True,
                sent_not_acked: False,
            }
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_empty_agent_ids_returns_empty_dict_without_query():
    """빈 목록이면 쿼리 자체를 안 한다(에이전트 0명인 org 등 edge case)."""
    from app.services.agent_verify import get_verified_map

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            result = await get_verified_map(s, [])
            assert result == {}
    finally:
        await engine.dispose()
