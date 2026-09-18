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


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일은 publish_registry_event/publish_preset_event/
    transition_gate/send_message 중 하나를 호출해 실제로 메시지를 발행하거나 게이트를
    전이시킨다 — `send_message`의 background task(`mark_agent_replied`)가 이 파일의
    throwaway 엔진이 아니라 `app.core.database.async_session_factory`(전역·프로세스
    수명 엔진)를 쓴다. destructive_schema 마커 파일이라 story #3330(PR#3711)이 conftest.py
    에 심은 전역 autouse(non-destructive 전용 스코프)의 적용 대상이 아니다 — 이 파일
    자신의 여러 테스트가 한 pytest 세션 안에서 순차 실행되며 같은 전역 엔진을 반복
    사용하므로, dispose 없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션
    누수/`Event loop is closed`로 이어질 수 있다(story #3330/PR#3711 실사고 — test_3330_
    gate_verdict_notification.py에서 최초 재현). 이 realdb 하네스의 표준 방어 fixture
    재사용(새 로직 0, story a05da51b — scripts/lint_destructive_publish_path_dispose_
    fixture.py 가드 대상)."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


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


def _fake_request() -> "StarletteRequest":
    """story #2674 — publish_registry_event가 이제 request(X-Project-Id 헤더 폴백)를 받는다.
    이 파일의 테스트들은 전부 work_item 참조가 있어 project 해소가 그 경로에서 끝나므로
    헤더 없는 최소 요청으로 충분(신규 파라미터 자리만 채운다)."""
    from starlette.requests import Request as StarletteRequest

    return StarletteRequest(scope={"type": "http", "headers": []})


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
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
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
