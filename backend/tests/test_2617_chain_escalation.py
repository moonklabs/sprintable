"""story #2617: human-less 대화의 chain-expired «관측» 축 검증.

(1) `_conversation_has_human`(channel_router.py) — 실물 참가자 조회가 정확한지(실PG).
(2) `escalate_unsupervised_chain`(chain_escalation.py) — org owner/admin에게 알림 발송 +
    24h/대화 dedup(fakeredis) + Redis 다운 시 fail-closed(스팸 방지 우선, PO 조건(a)).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

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


async def _seed_org_owner(session, org_id, *, role="owner"):
    from app.models.project import OrgMember

    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=uuid.uuid4(), role=role)
    session.add(om)
    await session.commit()
    return om.id


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


# ─── escalate_unsupervised_chain ──────────────────────────────────────────────

def _fakeredis_client():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    return aioredis.FakeRedis(server=server, decode_responses=True)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_escalate_notifies_org_owner_admin_once_then_dedups(monkeypatch):
    from app.services.chain_escalation import escalate_unsupervised_chain

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            owner_id = await _seed_org_owner(s, org_id, role="owner")
            await _seed_org_owner(s, org_id, role="member")  # non-admin — 대상 아님
            conv_id = await _seed_conversation(s, org_id, project_id)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await escalate_unsupervised_chain(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                    depth=7, cap=4,
                )
                dn.assert_awaited_once()
                kw = dn.await_args.kwargs
                assert kw["target_member_ids"] == [owner_id], "owner만 대상 — member role은 제외"
                assert kw["event_type"] == "conversation.unsupervised_chain_expired"
                assert kw["reference_id"] == conv_id

                # 재발화 — 같은 대화, 쿨다운 안(24h) → 두 번째 알림 0건(스팸 방지, PO 조건(a)).
                await escalate_unsupervised_chain(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                    depth=9, cap=4,
                )
                dn.assert_awaited_once(), "쿨다운 중 재발화는 dedup돼야(2번째 호출 무시)"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_escalate_different_conversations_each_notify_once():
    """dedup 키는 대화별 — 서로 다른 conv_id는 각자 독립적으로 1회씩 알림."""
    from app.services.chain_escalation import escalate_unsupervised_chain

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id, role="owner")
            conv_a = await _seed_conversation(s, org_id, project_id)
            conv_b = await _seed_conversation(s, org_id, project_id)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await escalate_unsupervised_chain(
                    s, org_id=org_id, conversation_id=conv_a, project_id=project_id, depth=5, cap=4,
                )
                await escalate_unsupervised_chain(
                    s, org_id=org_id, conversation_id=conv_b, project_id=project_id, depth=5, cap=4,
                )
                assert dn.await_count == 2, "서로 다른 대화는 dedup 키가 갈려 각자 알림돼야"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_escalate_redis_down_fails_closed_no_spam():
    """Redis 클라이언트 None(다운) → dedup 판정 불가 → fail-closed(알림 skip, 예외 0).
    스팸이 미발화보다 나쁘다는 PO 조건(a) 그대로."""
    from app.services.chain_escalation import escalate_unsupervised_chain

    session = AsyncMock()
    dn = AsyncMock()
    with patch("app.services.redis_shared.get_client", return_value=None), \
         patch("app.services.notification_dispatch.dispatch_notification", dn):
        await escalate_unsupervised_chain(
            session, org_id=uuid.uuid4(), conversation_id=uuid.uuid4(),
            project_id=uuid.uuid4(), depth=5, cap=4,
        )
    dn.assert_not_awaited()


@pytest.mark.anyio
async def test_escalate_swallows_exceptions_best_effort():
    """알림 경로 예외는 메시지 발신을 막지 않는다 — best-effort(다른 doc.py 알림 경로와 동형)."""
    from app.services.chain_escalation import escalate_unsupervised_chain

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("boom"))
    client = _fakeredis_client()
    with patch("app.services.redis_shared.get_client", return_value=client):
        await escalate_unsupervised_chain(
            session, org_id=uuid.uuid4(), conversation_id=uuid.uuid4(),
            project_id=uuid.uuid4(), depth=5, cap=4,
        )  # 예외 전파 없이 조용히 반환
