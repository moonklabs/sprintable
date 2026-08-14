"""story #2637 AC 0-a — publish_registry_event가 ConversationMessage.msg_metadata에
event_key+payload를 싣는다(approval_target 패턴과 동형 additive — send_message()의 기존
확장 메커니즘, E-ACTIVATION S1의 typed-field→msg_metadata 패턴을 그대로 따름).

이것 없으면 FE(#2637 렌더러 축)가 어떤 메시지가 "이벤트 발행분"인지 알 방법이 없다(미르코
실측 — 스토리 AC 0-a 자체가 그 발견에서 나옴).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

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


def _load_seed_definitions():
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0245tag", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return {key: (payload_schema, routing) for key, payload_schema, routing in m._SEED}


async def _seed_preset_definitions(session):
    from app.models.event_definition import EventDefinition

    for key, (payload_schema, routing) in _load_seed_definitions().items():
        session.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=None, payload_schema=payload_schema, routing=routing,
        ))
    await session.commit()


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2637tag", slug=slug)
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


async def _seed_story(session, org_id, project_id, *, human_owner_member_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S",
        human_owner_member_id=human_owner_member_id,
    )
    session.add(story)
    await session.commit()
    return story.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_tags_message_with_event_key_and_payload():
    from app.models.conversation import ConversationMessage
    from app.routers.events import EventPublishRequest, publish_registry_event
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=owner_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            assert msg.msg_metadata is not None
            assert msg.msg_metadata["event"]["event_key"] == "preset.gate.verdict"
            assert msg.msg_metadata["event"]["payload"]["gate_type"] == "merge"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_regular_chat_message_has_no_event_metadata():
    """일반 챗 메시지(이벤트 발행 아닌)는 msg_metadata['event']가 없어야 — additive 무회귀."""
    from app.routers.conversations import SendMessageRequest, send_message
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")

            from app.routers.events import _get_or_create_event_conversation

            conv = await _get_or_create_event_conversation(
                s, org_id=org_id, project_id=project_id,
                participant_ids={publisher_id}, created_by=publisher_id,
            )
            resp = await send_message(
                conv.id, SendMessageRequest(content="그냥 챗"), BackgroundTasks(),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["data"]["id"]))
            )).scalar_one()
            assert msg.msg_metadata is None
    finally:
        await engine.dispose()
