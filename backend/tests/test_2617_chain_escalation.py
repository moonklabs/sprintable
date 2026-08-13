"""story #2617: human-less 대화 판정 축 — `_conversation_has_human`(channel_router.py) 검증.

무감독 연쇄 «알림» 자체(에피소드 상태기계·org 설정·쿨다운)는 story #2626 재설계로
`chain_escalation.py`의 `evaluate_unsupervised_chain_episode`로 교체됐다 —
test_2626_chain_escalation_episode.py 참조. 이 파일은 #2626이 안 건드린 human-presence
판정 축(실물 참가자 조회)만 남긴다.
"""
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

    org = Organization(id=uuid.uuid4(), name="Org2617", slug=f"org2617-{uuid.uuid4().hex[:8]}")
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


async def _seed_conversation(session, org_id, project_id, *, conv_type="group"):
    from app.models.conversation import Conversation

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=conv_type)
    session.add(conv)
    await session.commit()
    return conv.id


async def _seed_participant(session, conversation_id, member_id):
    from app.models.conversation import ConversationParticipant

    session.add(ConversationParticipant(conversation_id=conversation_id, member_id=member_id))
    await session.commit()


# ─── _conversation_has_human ─────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_has_human_true_when_human_participant_present():
    from app.services.channel_router import _conversation_has_human

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent1 = await _seed_member(s, org_id, project_id, member_type="agent")
            human1 = await _seed_member(s, org_id, project_id, member_type="human")
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_participant(s, conv_id, agent1)
            await _seed_participant(s, conv_id, human1)

            assert await _conversation_has_human(s, conv_id) is True
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_has_human_false_when_all_agents():
    from app.services.channel_router import _conversation_has_human

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent1 = await _seed_member(s, org_id, project_id, member_type="agent")
            agent2 = await _seed_member(s, org_id, project_id, member_type="agent")
            conv_id = await _seed_conversation(s, org_id, project_id, conv_type="dm")
            await _seed_participant(s, conv_id, agent1)
            await _seed_participant(s, conv_id, agent2)

            assert await _conversation_has_human(s, conv_id) is False
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_has_human_false_for_empty_conversation():
    """참가자가 아예 없는(혹은 아직 조회 안 된) conversation_id — False로 안전측."""
    from app.services.channel_router import _conversation_has_human

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            assert await _conversation_has_human(s, uuid.uuid4()) is False
    finally:
        await engine.dispose()
