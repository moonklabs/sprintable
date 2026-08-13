"""story #2633(이벤트 레지스트리 P1a) — POST /api/v2/events/publish.

doc event-registry-core-p1-plan §2-2. 검증 축:
- AC1: 프리셋 발행이 실왕복으로 도달 — escalation=액션 대상(mentioned_ids)·broadcast=공람
  (참가자)이 구분돼 실측된다.
- AC2: 신규 전달 계통 금지 — publish_registry_event가 send_message()를 그대로 호출한다는 사실 자체가
  구조적 보증(별도 배달 로직 부재)이므로, 여기서는 그 위임의 결과(mentioned_ids가 정확히
  escalation_ids로 실린 메시지가 생성됨)로 간접 검증한다. route_message/webhook parity 자체는
  #2620/test_conversations.py가 이미 회귀 고정한 축이라 여기서 재검증하지 않는다.
- AC3: 스키마 위반·미존재 key는 4xx 명시 오류.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

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
        "_m0245c", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
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

    org = Organization(id=uuid.uuid4(), name="Org2633", slug=slug)
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


async def _seed_story(session, org_id, project_id, *, assignee_id=None, human_owner_member_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S",
        assignee_id=assignee_id, human_owner_member_id=human_owner_member_id,
    )
    session.add(story)
    await session.commit()
    return story.id


async def _seed_goal(session, org_id, project_id, *, assignee_id=None):
    from app.models.pm import Goal

    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="G", assignee_id=assignee_id)
    session.add(goal)
    await session.commit()
    return goal.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


# ─── AC1: 프리셋 발행 실왕복 — escalation/broadcast 구분 ───────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_work_assigned_escalation_is_assignee_mentioned():
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(assignee_id),
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(assignee_id)]
            assert str(assignee_id) in resp["broadcast_member_ids"]  # story_stakeholders에도 포함

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            assert msg.mentioned_ids == [assignee_id]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_gate_verdict_no_escalation_broadcasts_to_stakeholders():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)

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
            assert resp["escalation_member_ids"] == []  # verdict는 결과 통지, 개입 요청 없음
            assert str(stakeholder_id) in resp["broadcast_member_ids"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_goal_measured_resolves_goal_owner():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            goal_id = await _seed_goal(s, org_id, project_id, assignee_id=owner_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": str(goal_id), "metric_value": 12.5},
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["broadcast_member_ids"] == [str(owner_id)]
    finally:
        await engine.dispose()


# ─── 참가자 집합 재사용 — 대화 증식 방지 ────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_reuses_conversation_for_same_participant_set():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            def _body():
                from app.routers.events import EventPublishRequest as R
                return R(
                    definition_key="preset.work.assigned",
                    payload={
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "assignee_member_id": str(assignee_id),
                    },
                )

            resp1 = await publish_registry_event(
                _body(), BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            resp2 = await publish_registry_event(
                _body(), BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp1["conversation_id"] == resp2["conversation_id"]
            assert resp1["message_id"] != resp2["message_id"]
    finally:
        await engine.dispose()


# ─── AC3: 4xx 명시 오류 ──────────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unknown_definition_key_404():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(definition_key="preset.does.not_exist", payload={})
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_schema_violation_400():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={"work_item_type": "story"},  # 필수 필드 대량 누락
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            # story #2634 후속(#2633 정합): api_client.py의 _extract_error_message가 인식하는
            # {code,message} shape — errors 배열(기계가 읽을 상세)은 그대로 유지.
            assert ei.value.detail["code"] == "invalid_payload"
            assert ei.value.detail["message"]
            assert ei.value.detail["errors"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_routing_leg_missing_payload_field_raises():
    """payload_field routing이 요구하는 필드가 payload에 없거나 비면 명시 오류 — 조용한
    무해석 금지. preset.work.assigned는 스키마 자체가 assignee_member_id를 required로
    걸어 이 경로가 엔드포인트 레벨에선 항상 스키마 검증에 먼저 걸리므로(AC3와 중복 검증
    방지), 해석기 함수를 직접 호출해 이 축을 독립 검증한다."""
    from app.services.event_routing_resolver import MissingRoutingPayloadFieldError, resolve_routing_leg
    from unittest.mock import AsyncMock

    with pytest.raises(MissingRoutingPayloadFieldError):
        await resolve_routing_leg(
            {"kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id"},
            payload={"work_item_type": "story"},  # assignee_member_id 없음
            org_id=uuid.uuid4(), db=AsyncMock(),
        )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unresolvable_project_400():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": str(uuid.uuid4()), "metric_value": 1},  # 존재하지 않는 goal
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ─── 이해관계자 해석기 — story 복수 축(assignee_id·human_owner_member_id·StoryAssignee) ──

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_work_item_stakeholders_unions_all_story_axes():
    from app.services.event_routing_resolver import resolve_routing_leg
    from app.models.story_assignee import StoryAssignee

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            extra_id = await _seed_agent(s, org_id, project_id, name="extra")
            story_id = await _seed_story(
                s, org_id, project_id, assignee_id=assignee_id, human_owner_member_id=owner_id,
            )
            s.add(StoryAssignee(id=uuid.uuid4(), org_id=org_id, story_id=story_id, member_id=extra_id))
            await s.commit()

            ids = await resolve_routing_leg(
                {"kind": "server_derived", "target": "work_item_stakeholders"},
                payload={"work_item_type": "story", "work_item_id": str(story_id)},
                org_id=org_id, db=s,
            )
            assert ids == {assignee_id, owner_id, extra_id}
    finally:
        await engine.dispose()
