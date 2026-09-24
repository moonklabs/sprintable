"""story #4242 — 서버가 낸 발행 단계(channel_connection stage) 이벤트가 **다음 단계 담당 에이전트**에게 간다.

뉴스레터 «검수(review)» 승인 → 서버가 «캠페인 생성(campaign_created)»을 낸다. 그 stage의 바인딩은 채널 연결뿐이라
받을 에이전트가 없어 이벤트가 아무에게도 안 갔고, 다음 단계 «발송 요청(send_requested)»을 낼 Publisher 에이전트는
발송 예시·봉인 필드(`publication_id` 등)를 몰랐다.

- 규칙 1: channel_connection stage의 수신자 = 다음 stage에 바인딩된 멤버(에이전트·사람 종류 무관). 바인딩이 없거나 다음
  stage가 또 다른 서버 stage면 0 + 로그 경고(PO 확정 · 까디르 4601 QA P2 주장 정정).
- 규칙 2: 서버가 낸 발행 단계 payload에 방금 만든 발행물 id(`publication_id`)를 싣는다 — 정의의 payload_schema가 그
  필드를 선언할 때만(SNS·영상은 `additionalProperties: false`).
- 본문은 기존 렌더러 그대로 — 다음 단계 발행 예시 + 봉인 필드 안내.
"""
from __future__ import annotations

import logging
import os
import uuid

import pytest
from sqlalchemy import select

from tests.test_4093_scheduled_publish_event_realdb import _seed_system_publisher_teammember_shim
from tests.test_4191_recipe_newsletter_send_realdb import _setup
from tests.test_4214_newsletter_send_recipe_stage_realdb import _load_0398_seed
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_SEED = _load_0398_seed()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _ensure_newsletter_preset(Session):
    from app.models.event_definition import EventDefinition

    async with Session() as s:
        if (await s.execute(
            select(EventDefinition).where(EventDefinition.key == _SEED._KEY, EventDefinition.org_id.is_(None))
        )).scalars().first() is None:
            s.add(EventDefinition(
                id=uuid.uuid4(), key=_SEED._KEY, org_id=None, name=_SEED._NAME, description=_SEED._DESCRIPTION,
                payload_schema=_SEED._PAYLOAD_SCHEMA, routing=_SEED._ROUTING, block_template=_SEED._BLOCK_TEMPLATE,
                stage_metadata=_SEED._STAGE_METADATA, role_actor_kinds=_SEED._ROLE_ACTOR_KINDS, enabled=True, version=1,
            ))
            await s.commit()


async def _bind_agent(Session, ctx, *, definition_key: str, stage: str, agent_id: uuid.UUID):
    from app.models.recipe_role_binding import RecipeRoleBinding

    async with Session() as s:
        s.add(RecipeRoleBinding(
            id=uuid.uuid4(), org_id=ctx["org_id"], project_id=ctx["project_id"],
            event_definition_key=definition_key, stage=stage, agent_member_id=agent_id,
        ))
        await s.commit()


async def _emit(Session, ctx, *, definition_key: str, stage: str, publication_id: uuid.UUID | None):
    from app.services.channel_posts import emit_recipe_published_stage_event

    async with Session() as s:
        await emit_recipe_published_stage_event(
            s, org_id=ctx["org_id"], work_item_type="story", work_item_id=ctx["story_id"],
            definition_key=definition_key, next_stage=stage, publication_id=publication_id,
        )


async def _stage_message_and_participants(Session, ctx, *, definition_key: str, stage: str):
    from app.models.conversation import ConversationParticipant
    from app.routers.events import _find_existing_stage_publish

    async with Session() as s:
        message = await _find_existing_stage_publish(
            s, org_id=ctx["org_id"], definition_key=definition_key, work_item_type="story",
            work_item_id=str(ctx["story_id"]), stage=stage,
        )
        assert message is not None, f"{stage} 이벤트가 안 났다"
        participants = set((await s.execute(
            select(ConversationParticipant.member_id).where(
                ConversationParticipant.conversation_id == message.conversation_id
            )
        )).scalars().all())
    return message, participants


async def _setup_newsletter(Session):
    await _ensure_newsletter_preset(Session)
    ctx = await _setup(Session)
    async with Session() as s:
        await _seed_system_publisher_teammember_shim(s, ctx["org_id"], ctx["project_id"])
        sender_id = await _seed_agent(s, ctx["org_id"], ctx["project_id"])
        bystander_id = await _seed_agent(s, ctx["org_id"], ctx["project_id"])
    return {**ctx, "sender_id": sender_id, "bystander_id": bystander_id}


@pytest.mark.anyio
async def test_campaign_created_reaches_send_requested_agent_with_sealed_fields_and_publication_id():
    """⭐AC — 캠페인 생성(서버 발행) → 발송 요청 담당 에이전트가 받고, 본문엔 발송 요청 발행 예시 + 봉인 필드 3개 안내,
    payload엔 방금 만든 발행물 id."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup_newsletter(Session)
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="send_requested", agent_id=ctx["sender_id"])
        # 다른 단계 담당은 받지 않는다(규칙 1은 «다음 단계» 하나만).
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="draft", agent_id=ctx["bystander_id"])

        await _emit(Session, ctx, definition_key=_SEED._KEY, stage="campaign_created", publication_id=ctx["pub"].id)

        message, participants = await _stage_message_and_participants(
            Session, ctx, definition_key=_SEED._KEY, stage="campaign_created",
        )
        assert ctx["sender_id"] in participants, "발송 요청 담당 에이전트가 캠페인 생성 이벤트를 못 받았다"
        assert ctx["bystander_id"] not in participants

        payload = message.msg_metadata["event"]["payload"]
        assert payload["publication_id"] == str(ctx["pub"].id)

        body = message.content
        assert '"stage": "send_requested"' in body
        for field in ("publication_id", "segment_name", "scheduled_at"):
            assert f'"{field}"' in body, field
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_next_stage_bound_to_a_human_member_reaches_that_person():
    """까디르 4601 QA P2 · PO 판단 — 규칙은 «다음 stage에 바인딩된 멤버(종류 무관)». 사람을 바인딩했으면 그 사람이 받는다
    (명시적 바인딩 = «아는» 경우 · 4243 `either`로 사람 바인딩이 정식)."""
    from app.models.team import TeamMember

    engine, Session = await _session_factory()
    try:
        ctx = await _setup_newsletter(Session)
        async with Session() as s:
            person = TeamMember(
                id=uuid.uuid4(), org_id=ctx["org_id"], project_id=ctx["project_id"], type="human", name="발송 담당자",
                is_active=True,
            )
            s.add(person)
            await s.commit()
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="send_requested", agent_id=person.id)

        await _emit(Session, ctx, definition_key=_SEED._KEY, stage="campaign_created", publication_id=ctx["pub"].id)

        _message, participants = await _stage_message_and_participants(
            Session, ctx, definition_key=_SEED._KEY, stage="campaign_created",
        )
        assert person.id in participants
        assert ctx["sender_id"] not in participants and ctx["bystander_id"] not in participants
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_next_stage_without_a_bound_member_reaches_nobody_and_logs_warning(caplog):
    """PO 확정 — 다음 stage에 바인딩된 멤버가 없으면(미배정) 0 + 로그 경고. 다른 stage 담당에게 새지 않는다."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup_newsletter(Session)
        await _bind_agent(Session, ctx, definition_key=_SEED._KEY, stage="draft", agent_id=ctx["bystander_id"])

        with caplog.at_level(logging.WARNING, logger="app.services.event_routing_resolver"):
            await _emit(Session, ctx, definition_key=_SEED._KEY, stage="campaign_created", publication_id=ctx["pub"].id)

        _message, participants = await _stage_message_and_participants(
            Session, ctx, definition_key=_SEED._KEY, stage="campaign_created",
        )
        assert ctx["bystander_id"] not in participants
        assert ctx["sender_id"] not in participants
        assert any(
            "channel stage 'campaign_created' -> next stage 'send_requested' has no bound member" in r.getMessage()
            for r in caplog.records
        ), [r.getMessage() for r in caplog.records]
    finally:
        await engine.dispose()


_CLOSED_SCHEMA_KEY_PREFIX = "org.r4242"
_CLOSED_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["write", "published", "checked"]},
        "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_CLOSED_STAGE_METADATA = {
    "write": {"role": "Creator", "action": "글 쓰기"},
    "published": {"role": "Publisher", "action": "발행", "capability": {"kind": "publish", "target": "channel_connection"}},
    "checked": {"role": "Publisher", "action": "발행 확인"},
}


@pytest.mark.anyio
async def test_definition_without_publication_id_field_publishes_without_it_and_still_routes_to_next_agent():
    """SNS·영상처럼 payload_schema가 `publication_id`를 선언하지 않는(additionalProperties false) 정의 — 발행물 id를
    넘겨도 싣지 않아 발행이 검증에서 막히지 않고, 다음 단계 담당에게 간다."""
    from app.models.event_definition import EventDefinition

    engine, Session = await _session_factory()
    try:
        ctx = await _setup_newsletter(Session)
        key = f"{_CLOSED_SCHEMA_KEY_PREFIX}{uuid.uuid4().hex[:6]}.sns_cycle"
        async with Session() as s:
            s.add(EventDefinition(
                id=uuid.uuid4(), key=key, org_id=ctx["org_id"], name="닫힌 스키마 레시피",
                payload_schema=_CLOSED_SCHEMA, routing=_SEED._ROUTING, stage_metadata=_CLOSED_STAGE_METADATA,
            ))
            await s.commit()
        await _bind_agent(Session, ctx, definition_key=key, stage="checked", agent_id=ctx["sender_id"])

        await _emit(Session, ctx, definition_key=key, stage="published", publication_id=ctx["pub"].id)

        message, participants = await _stage_message_and_participants(Session, ctx, definition_key=key, stage="published")
        assert "publication_id" not in message.msg_metadata["event"]["payload"]
        assert ctx["sender_id"] in participants
    finally:
        await engine.dispose()
