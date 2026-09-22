"""story #4085(2/2, [E-RECIPE-1], 페드루 PO CHANGES — 2호 실측 재발) — AC1: 다음 stage가
게이트를 여는데 그 gate_type이 봉인 필드를 요구하면, 그 필드를 실값 예시로 자기설명
멘션에 싣고 설명 문구를 붙인다.

PR #4461이 사이클 자기설명 렌더러(`_render_event_message_content`)에는 이 로직을
붙였으나(AC1 커밋 메시지가 "2/2" 완료라 주장), 게이트 판정 렌더러(`_render_gate_
verdict_message`)에는 붙이지 않았다 — 2호 실측에서 실제로 댄이 받는 멘션은 **이
판정 렌더러 쪽**(structure_approval 게이트를 사람이 승인한 직후 댄에게 도달하는
"다음 행동" 알림)이다: `animatic`(현재 stage)이 **자기 게이트**(structure_approval)를
열기 때문에 사이클 렌더러는 그 자리에서 스코프 B(대기 문구, 발행 예시 생략)로
빠지고, 실제 발행 예시는 그 게이트가 **승인된 뒤** 판정 렌더러가 낸다 — 봉인 필드
주입이 누락된 채로 2호 rehearsal에 그대로 재발했다(라이브 grounding, curl로 실
recipe definition stage_metadata 확認: animatic→gate=structure_approval,
structure_passed→gate=generation_budget, 정확히 이 경로).

세팅 헬퍼는 test_4090_ac2_recipe_auto_publish_realdb.py의 하네스를 그대로 미러
(발명 0) — gate_b(structure_approval) 승인까지만 밟고, 그 직후 댄(creator)에게
도달한 메시지 내용을 test_3330_gate_verdict_notification.py의
`_latest_message_content_for` 패턴으로 확인한다."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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


def _load_migration_module(filename: str, alias: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        alias, os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", filename),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4085")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4085",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4085",
)
_KEY = "preset.4085.video_production"
_PAYLOAD_SCHEMA = _MIG_0382._NEW_PAYLOAD_SCHEMA
_ROUTING = _MIG_0381._ROUTING
_STAGE_METADATA = _MIG_0387._NEW_STAGE_METADATA


async def _realdb_session():
    from sqlalchemy import text as sa_text
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
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_references_non_proof "
            "ON entity_references (source_type, source_field, source_id, target_type, target_id, form, relation) "
            "WHERE form <> 'proof'"
        ))
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE runtime_type = 'system-publisher' AND type = 'agent'"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org4085", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user_id = uuid.uuid4()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user_id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human",
        name="org owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id, owner_user_id


async def _seed_system_publisher_teammember_shim(session, org_id, project_id):
    """test_4090_ac2_recipe_auto_publish_realdb.py와 동형(발명 0) — `team_members`는
    실 DB에선 VIEW(0088+)지만 이 파일의 `Base.metadata.create_all()` 하네스는 raw
    op.execute로 정의된 그 VIEW를 못 만든다. 이 shim 없이는 `publish_preset_event`
    (`preset.gate.verdict` 자동발행)가 `_get_or_create_system_publisher`로 만든
    시스템 발행자의 `resolve_member`에서 "Team member not found"(400)로 조용히
    실패해도(그 함수 자신의 try/except가 삼킨다) verdict 알림 자체가 하나도 안
    만들어진다(실측 — 이 shim 없이 돌렸을 때 gate 승인 2회 다 이 예외로 실패)."""
    from app.models.team import TeamMember
    from app.routers.events import _get_or_create_system_publisher

    system_member = await _get_or_create_system_publisher(session, org_id)
    session.add(TeamMember(
        id=system_member.id, org_id=org_id, project_id=project_id, type="agent",
        name="시스템 발행", is_active=True,
    ))
    await session.commit()


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id, title="AC1 봉인필드 예시"):
    """test_3330_gate_verdict_notification.py와 동형(발명 0) — assignee_id 없이는
    event_routing_resolver.py::_resolve_work_item_stakeholders가 이 story의
    이해관계자를 못 찾아 verdict 알림이 아무에게도 안 닿는다(실측: #4090 하네스를
    그대로 재사용했을 때 creator에게 도달한 메시지가 0건이었다 — #4090 자신은 메시지
    "내용"을 단언한 적이 없어 이 갭이 안 드러났을 뿐)."""
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(4085 테스트)",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


_PRESET_GATE_VERDICT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "gate_type", "verdict"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_title": {"type": ["string", "null"]},
        "gate_type": {"type": "string"},
        "verdict": {"type": "string", "enum": ["approved", "rejected"]},
        "resolver_member_id": {"type": "string", "format": "uuid"},
        "resolution_note": {"type": ["string", "null"]},
        "gate_requester_member_id": {"type": "string", "format": "uuid"},
        "gate_draft_author_member_id": {"type": "string", "format": "uuid"},
        "gate_id": {"type": "string", "format": "uuid"},
    },
}
_PRESET_GATE_VERDICT_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {
        "kind": "server_derived", "target": "work_item_stakeholders",
        "inherit_conversation_scope": True,
    },
}


async def _seed_preset_gate_verdict_definition(session):
    """test_3330_gate_verdict_notification.py와 동형(발명 0) — realdb 테스트 DB는
    `Base.metadata.create_all`로 스키마만 얻고 alembic 시드 마이그레이션(0245_event_
    definitions.py)은 안 타므로, 그게 심는 `preset.gate.verdict` 프리셋 정의를 직접
    재현해 심는다. 이게 없으면 `publish_preset_event`가 "정의 없음"으로 조용히
    no-op해 검증 게이트를 승인해도 verdict 알림 자체가 안 만들어진다(실측 — 이
    시드 없이 돌렸을 때 creator에게 도달한 verdict 메시지가 0건이었다)."""
    from app.models.event_definition import EventDefinition
    from sqlalchemy import select

    existing = (await session.execute(
        select(EventDefinition).where(
            EventDefinition.key == "preset.gate.verdict", EventDefinition.org_id.is_(None),
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    session.add(EventDefinition(
        id=uuid.uuid4(), key="preset.gate.verdict", org_id=None,
        payload_schema=_PRESET_GATE_VERDICT_SCHEMA, routing=_PRESET_GATE_VERDICT_ROUTING,
        enabled=True, version=1,
    ))
    await session.commit()


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext

    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest

    return StarletteRequest(scope={"type": "http", "headers": []})


async def _latest_message_content_for(session, agent_id, org_id):
    """test_3330_gate_verdict_notification.py와 동형(발명 0) — agent_id가 참가자인
    conversation들 중 가장 최근 메시지 내용(도달 확認용)."""
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from sqlalchemy import select

    row = (await session.execute(
        select(ConversationMessage)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == ConversationMessage.conversation_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(ConversationParticipant.member_id == agent_id, Conversation.org_id == org_id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    return row.content if row is not None else None


async def _approve_through_structure_gate(s, *, org_id, story_id, creator_id, owner_member_id):
    """concept_approval까지 승인한 뒤 animatic을 발행해 structure_approval 게이트를
    열고, 그 게이트를 승인한다(2호가 실제로 멈춘 지점 바로 그 자리) — #4090 하네스의
    `_walk_to_pending_approval_with_abc_approved` 앞부분만 재사용, generation_budget/
    external_publish까지는 안 간다(이 테스트의 관심은 그 직후 댄에게 도달한 멘션 1건)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate

    async def _publish(stage: str, *, actor_id: uuid.UUID):
        payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload=payload),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
        )

    await _publish("draft", actor_id=creator_id)
    await _publish("concept_confirmed", actor_id=creator_id)
    gate_a = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
    await s.commit()

    await _publish("animatic", actor_id=creator_id)
    gate_b = (await s.execute(
        select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "structure_approval")
    )).scalar_one()
    await transition_gate(s, org_id, gate_b.id, "approved", owner_member_id, None)
    await s.commit()


@pytest.mark.anyio
async def test_ac1_gate_verdict_mention_includes_sealed_field_and_explanation():
    """AC1/AC3(a) — structure_approval 게이트 승인 직후 댄(creator)에게 도달한 멘션에
    다음 stage(structure_passed)의 봉인 필드(estimated_cost_minor) 실값 예시와 설명
    문구가 둘 다 실려야 한다. 2호 실사고 재현 — 이 단언이 고쳐지기 前엔 필드·설명
    둘 다 0건이었다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4085a")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)
            await _seed_definition(s)
            await _seed_preset_gate_verdict_definition(s)

            await _approve_through_structure_gate(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

            content = await _latest_message_content_for(s, creator_id, org_id)
            assert content is not None, "structure_approval 승인 뒤 댄에게 도달한 메시지가 없다"
            assert '"estimated_cost_minor": 10000' in content, (
                f"봉인 필드 실값 예시가 발행 예시 payload에 없다: {content!r}"
            )
            assert "estimated_cost_minor는 위 예시값이 아니라 실제 예상 비용" in content, (
                f"봉인 필드 설명 문구가 안 실렸다(에이전트가 그냥 예시값 그대로 발행할 위험): {content!r}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1_next_stage_without_sealed_gate_unaffected_regression():
    """회귀 음성대조 — concept_approval 승인 직후(다음 stage=animatic, 그 stage의 gate=
    structure_approval이지만 봉인 필드 선언 자체가 없는 gate_type)는 기존처럼 봉인 필드
    설명 줄이 안 붙는다(엉뚱한 gate_type에도 무조건 설명을 붙이는 회귀 방지)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.services.gate_service import transition_gate

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4085b")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)
            await _seed_definition(s)
            await _seed_preset_gate_verdict_definition(s)

            async def _publish(stage: str, *, actor_id: uuid.UUID):
                payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
                await publish_registry_event(
                    EventPublishRequest(definition_key=_KEY, payload=payload),
                    BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
                )

            await _publish("draft", actor_id=creator_id)
            await _publish("concept_confirmed", actor_id=creator_id)
            gate_a = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept_approval")
            )).scalar_one()
            await transition_gate(s, org_id, gate_a.id, "approved", owner_member_id, None)
            await s.commit()

            content = await _latest_message_content_for(s, creator_id, org_id)
            assert content is not None
            assert "estimated_cost_minor" not in content, (
                f"concept_approval(봉인 필드 미선언 gate_type)인데도 예산 필드 문구가 샜다: {content!r}"
            )
    finally:
        await engine.dispose()
