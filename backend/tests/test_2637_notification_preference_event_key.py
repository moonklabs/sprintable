"""story #2637 §0-c(#2636서 이관) — NotificationPreference event_key 축 + channel_router
대조, "이 이벤트타입 mute" 실왕복.

카디르 QA가 요구한 정확한 시나리오: 회원이 특정 event_key를 mute로 설정하면, 그 event_key로
태깅된(#2637 AC 0-a) 메시지가 route_message()에서 그 회원에게만 DeliveryDecision을 안 낸다
— 실 DB(NotificationPreference·ConversationMessage 둘 다 실 테이블)로 왕복 검증.
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


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2637nk", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_group_conversation(session, org_id, project_id, *, participant_ids, created_by):
    from app.routers.conversations import _create_conversation_record

    return await _create_conversation_record(
        session, org_id=org_id, project_id=project_id, member_ids=set(participant_ids),
        conv_type="group", title=None, created_by=created_by,
    )


async def _seed_event_tagged_message(session, conv_id, sender_id, event_key: str):
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content="[이벤트] " + event_key,
        msg_metadata={"event": {"event_key": event_key, "payload": {}}},
    )
    session.add(msg)
    await session.commit()
    return msg.id


async def _seed_event_key_mute_pref(session, member_id, event_key: str, *, channel="sse"):
    from app.models.notification_preference import NotificationPreference

    p = NotificationPreference(
        id=uuid.uuid4(), member_id=member_id, scope_type="event_key",
        scope_id=None, event_key=event_key, channel=channel, level="mute",
    )
    session.add(p)
    await session.commit()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_event_key_mute_excludes_recipient_from_delivery_decisions():
    from app.services.channel_router import route_message

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender_id = await _seed_agent(s, org_id, project_id, name="publisher")
            muter_id = await _seed_agent(s, org_id, project_id, name="muter")
            other_id = await _seed_agent(s, org_id, project_id, name="other")

            conv = await _seed_group_conversation(
                s, org_id, project_id,
                participant_ids={sender_id, muter_id, other_id}, created_by=sender_id,
            )
            await _seed_event_key_mute_pref(s, muter_id, "org.acme.widget.made")

            msg_id = await _seed_event_tagged_message(s, conv.id, sender_id, "org.acme.widget.made")

            decisions = await route_message(msg_id, s)
            decided_ids = {d.member_id for d in decisions}

            assert muter_id not in decided_ids, "event_key mute를 설정한 수신자는 제외돼야 한다"
            assert other_id in decided_ids, "mute 안 한 수신자는 그대로 받아야 한다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_event_key_mute_does_not_affect_other_event_keys():
    """특정 event_key만 mute — 다른 event_key로 태깅된 메시지는 그대로 받아야(범위 정밀성)."""
    from app.services.channel_router import route_message

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender_id = await _seed_agent(s, org_id, project_id, name="publisher")
            muter_id = await _seed_agent(s, org_id, project_id, name="muter")

            conv = await _seed_group_conversation(
                s, org_id, project_id, participant_ids={sender_id, muter_id}, created_by=sender_id,
            )
            await _seed_event_key_mute_pref(s, muter_id, "org.acme.widget.made")

            other_msg_id = await _seed_event_tagged_message(s, conv.id, sender_id, "org.acme.thing.done")

            decisions = await route_message(other_msg_id, s)
            decided_ids = {d.member_id for d in decisions}
            assert muter_id in decided_ids
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_scope_still_wins_over_event_key_scope():
    """대화-구조 축(conversation)이 event_key 축보다 여전히 우선(더 구체적인 사용자 커스텀이
    이긴다) — 이번엔 conversation-scope로 "all"을 명시했으면 event_key mute를 뒤집는다."""
    from app.services.channel_router import route_message
    from app.models.notification_preference import NotificationPreference

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender_id = await _seed_agent(s, org_id, project_id, name="publisher")
            member_id = await _seed_agent(s, org_id, project_id, name="member")

            conv = await _seed_group_conversation(
                s, org_id, project_id, participant_ids={sender_id, member_id}, created_by=sender_id,
            )
            await _seed_event_key_mute_pref(s, member_id, "org.acme.widget.made")
            s.add(NotificationPreference(
                id=uuid.uuid4(), member_id=member_id, scope_type="conversation",
                scope_id=conv.id, channel="sse", level="all",
            ))
            await s.commit()

            msg_id = await _seed_event_tagged_message(s, conv.id, sender_id, "org.acme.widget.made")

            decisions = await route_message(msg_id, s)
            decided_ids = {d.member_id for d in decisions}
            assert member_id in decided_ids, "conversation-scope 명시 커스텀이 event_key mute보다 우선해야 한다"
    finally:
        await engine.dispose()
