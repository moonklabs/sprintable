"""story #2935(설계 doc steer-event-axis-design-2927 §1/§2 확定분) — EventPublishRequest.
conversation_id 오버라이드 + preset.steer.instruct 신규 정의.

- §2 보강: conversation_id 지정 시 escalation 대상이 그 conversation의 실 참가자가 아니면
  422(fail-closed, 조용한 미도달 방지) — doc의 대안 ⓑ(자동 멘션 부여) 기각 근거 그대로.
- §1: preset.steer.instruct가 실제로 조회/발행 가능한지(escalation=target_member_id,
  broadcast=work_item_stakeholders).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

from tests.test_2633_event_publish import (
    _REAL_DB_URL,
    _auth,
    _fake_request,
    _realdb_session,
    _seed_agent,
    _seed_org_project,
    _seed_story,
)

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _load_steer_definition():
    """0274 마이그의 시드 데이터를 실 코드에서 동적 로드 — test_2633의 `_load_seed_definitions`
    (0245 로드)와 동일 패턴, 신규 헬퍼 발명 금지. (원래 0272로 작성됐으나 develop #3359와
    번호 충돌해 0274로 재넘버링됨 — PR#3368 코멘트 참조.)"""
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0274steer",
        os.path.join(
            os.path.dirname(__file__), "..", "alembic", "versions",
            "0274_event_definitions_preset_steer_instruct.py",
        ),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m._KEY, m._PAYLOAD_SCHEMA, m._ROUTING, m._BLOCK_TEMPLATE


async def _seed_steer_definition(session):
    from app.models.event_definition import EventDefinition

    key, payload_schema, routing, block_template = _load_steer_definition()
    session.add(EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None,
        payload_schema=payload_schema, routing=routing, block_template=block_template,
    ))
    await session.commit()


async def _seed_preset_work_assigned(session):
    """conversation_id 오버라이드 테스트는 기존 preset.work.assigned(단순 payload_field
    escalation)를 재사용 — 신규 정의 없이도 §2 로직 자체를 검증할 수 있다."""
    from app.models.event_definition import EventDefinition

    session.add(EventDefinition(
        id=uuid.uuid4(), key="preset.work.assigned", org_id=None,
        payload_schema={
            "type": "object", "additionalProperties": False,
            "required": ["work_item_type", "work_item_id", "assignee_member_id"],
            "properties": {
                "work_item_type": {"type": "string"},
                "work_item_id": {"type": "string", "format": "uuid"},
                "assignee_member_id": {"type": "string", "format": "uuid"},
                "assigned_by_member_id": {"type": ["string", "null"], "format": "uuid"},
            },
        },
        routing={
            "escalation": {
                "kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id",
            },
            "broadcast": {
                "kind": "server_derived", "target": "work_item_stakeholders",
                "inherit_conversation_scope": True,
            },
        },
    ))
    await session.commit()


async def _seed_conversation(session, org_id, project_id, *, participant_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group",
        title="Steer target conv", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for member_id in participant_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=member_id))
    await session.commit()
    return conv.id


# ─── §2 보강: conversation_id 오버라이드 ────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_id_override_publishes_into_specified_conversation():
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.conversation import Conversation
    from sqlalchemy import func, select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_work_assigned(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)
            target_conv_id = await _seed_conversation(
                s, org_id, project_id,
                participant_ids={publisher_id, assignee_id}, created_by=publisher_id,
            )

            before_count = (await s.execute(
                select(func.count()).select_from(Conversation).where(Conversation.org_id == org_id)
            )).scalar_one()

            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(assignee_id),
                },
                conversation_id=target_conv_id,
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["conversation_id"] == str(target_conv_id), "지정한 conversation에 발행돼야 함"

            after_count = (await s.execute(
                select(func.count()).select_from(Conversation).where(Conversation.org_id == org_id)
            )).scalar_one()
            assert after_count == before_count, "오버라이드 경로는 새 conversation을 만들면 안 됨"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_id_override_rejects_when_escalation_target_not_participant():
    """doc §2 보강 — escalation 대상(target_member_id)이 지정 conversation의 실 참가자가
    아니면 422(fail-closed) — 조용한 미도달 방지. 대안 ⓑ(자동 멘션 부여)는 기각됨."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_work_assigned(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)
            # assignee_id를 «넣지 않은» 대화 — escalation 대상이 참가자가 아닌 상태 재현.
            target_conv_id = await _seed_conversation(
                s, org_id, project_id, participant_ids={publisher_id}, created_by=publisher_id,
            )

            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(assignee_id),
                },
                conversation_id=target_conv_id,
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "conversation_target_mismatch"
            assert str(assignee_id) in ei.value.detail["errors"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_id_override_none_preserves_get_or_create_behavior():
    """conversation_id 미지정(기존 호출부 전부) — 무회귀. 기존 _get_or_create_event_
    conversation 경로가 그대로 새/재사용 conversation을 만든다."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_work_assigned(s)
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
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(assignee_id)]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_conversation_id_override_404_when_not_found():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_work_assigned(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(assignee_id),
                },
                conversation_id=uuid.uuid4(),  # 존재하지 않음.
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


# ─── §1: preset.steer.instruct 신규 정의 실왕복 ─────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_steer_instruct_escalates_to_target_broadcasts_to_stakeholders():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_steer_definition(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)

            body = EventPublishRequest(
                definition_key="preset.steer.instruct",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "target_member_id": str(target_id),
                    "instruction": "이 스토리 우선순위를 올려주세요",
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(target_id)]
            assert str(stakeholder_id) in resp["broadcast_member_ids"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_steer_instruct_missing_instruction_400():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_steer_definition(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            story_id = await _seed_story(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.steer.instruct",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "target_member_id": str(target_id),
                    # instruction 누락 — payload_schema required 위반.
                },
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()
