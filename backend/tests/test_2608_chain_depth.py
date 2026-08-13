"""story #2608 P1 — compute_agent_chain_depth 핵심 알고리즘(실 PG).

"최근 human 메시지 이후 연속 agent 발신 메시지 수"를 상태(카운터 컬럼) 없이 매번 유도하는
쿼리의 정확성을 검증한다 — depth 산정이 틀리면 P1 전체(cap 판정·human-intervention 발생
여부)가 틀린다."""
from __future__ import annotations

import uuid

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2608", slug=f"org2608-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_member(session, org_id, project_id, *, member_type):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=member_type,
        name=member_type, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_conversation(session, org_id, project_id):
    from app.models.conversation import Conversation

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group")
    session.add(conv)
    await session.commit()
    return conv.id


async def _seed_message(session, conversation_id, sender_id, *, seq_offset):
    from datetime import datetime, timedelta, timezone
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id,
        content=f"msg-{seq_offset}",
        # 명시 created_at으로 최신순 정렬을 결정론적으로 고정(같은 트랜잭션 내 여러 insert가
        # server_default now()로 동시각/역전될 위험 제거).
        created_at=datetime(2026, 8, 13, tzinfo=timezone.utc) + timedelta(seconds=seq_offset),
    )
    session.add(msg)
    await session.commit()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_depth_counts_consecutive_agent_messages_from_most_recent():
    from app.services.chain_depth import compute_agent_chain_depth

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            human_id = await _seed_member(s, org_id, project_id, member_type="human")
            agent_a = await _seed_member(s, org_id, project_id, member_type="agent")
            agent_b = await _seed_member(s, org_id, project_id, member_type="agent")
            conv_id = await _seed_conversation(s, org_id, project_id)

            await _seed_message(s, conv_id, human_id, seq_offset=0)
            await _seed_message(s, conv_id, agent_a, seq_offset=1)
            await _seed_message(s, conv_id, agent_b, seq_offset=2)
            await _seed_message(s, conv_id, agent_a, seq_offset=3)

        async with Session() as s:
            depth = await compute_agent_chain_depth(s, conv_id, max_scan=10)
            assert depth == 3, "human 이후 agent 3연속(A·B·A) — 그 앞의 human까지는 안 세야"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_human_message_resets_depth_to_zero():
    from app.services.chain_depth import compute_agent_chain_depth

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            human_id = await _seed_member(s, org_id, project_id, member_type="human")
            agent_a = await _seed_member(s, org_id, project_id, member_type="agent")
            conv_id = await _seed_conversation(s, org_id, project_id)

            await _seed_message(s, conv_id, agent_a, seq_offset=0)
            await _seed_message(s, conv_id, agent_a, seq_offset=1)
            await _seed_message(s, conv_id, human_id, seq_offset=2)  # 가장 최근 = human

        async with Session() as s:
            depth = await compute_agent_chain_depth(s, conv_id, max_scan=10)
            assert depth == 0, "가장 최근 메시지가 human이면(=바로 그 앵커) depth는 0이어야"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_depth_bounded_by_max_scan_when_no_human_in_window():
    """human 메시지가 max_scan 범위 밖에 있으면(또는 아예 없으면) depth는 max_scan+1에서
    멈춘다(그 이상 스캔 안 함 — O(max_scan) 비용 상한이 실제로 지켜지는지)."""
    from app.services.chain_depth import compute_agent_chain_depth

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_a = await _seed_member(s, org_id, project_id, member_type="agent")
            conv_id = await _seed_conversation(s, org_id, project_id)

            for i in range(10):  # human 없이 agent만 10개
                await _seed_message(s, conv_id, agent_a, seq_offset=i)

        async with Session() as s:
            depth = await compute_agent_chain_depth(s, conv_id, max_scan=4)
            assert depth == 5, "LIMIT max_scan+1(=5)까지만 보고 그 값 그대로 반환해야"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_empty_conversation_depth_zero():
    from app.services.chain_depth import compute_agent_chain_depth

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            conv_id = await _seed_conversation(s, org_id, project_id)

        async with Session() as s:
            depth = await compute_agent_chain_depth(s, conv_id, max_scan=10)
            assert depth == 0
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
