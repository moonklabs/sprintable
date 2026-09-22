"""story #4149([E-RECIPE-1·Phase 3 폴리시], 리허설 2호 실측·#4145 스모크·페드루 PO 確定
2026-09-22) — 멘션 템플릿 2문장이 실제 게이트/발행 상태와 다른 세계를 말하던 결함:

① stage 진입 자기설명 멘션(`_render_event_message_content`, scope B)의 «승인자» 절이
   stage_metadata[stage].gate.approver 역할참조 슬러그("org_owner")를 그대로 문장에
   꽂았다 — #4083(OrgGatePolicy.recipe_gate_default_approver_member_id)가 실제로는
   다른 멤버를 지정했어도 멘션은 항상 "org_owner"만 말했다.
② 게이트 판정 멘션(`_render_gate_verdict_message`)의 external_publish approved
   "다음 행동" 문구가, gate_row 자신이 unscoped(scope_key="") 레시피 게이트라
   publish_outcome이 같은 트랜잭션에서 이미 채워져 있는데도(#4090/#4142 자동발행 훅)
   그 값을 안 읽고 기존 human_only 문구로 떨어졌다 — #4142가 고친 축은 gate_row가
   "scoped" 쪽(역방향 조회)뿐이었다.

세팅 헬퍼는 test_4085_recipe_mention_sealed_field_example_realdb.py의 하네스를 그대로
재사용(발명 0) — org/owner/agent/story/definition 시드, system-publisher shim,
_latest_message_content_for 패턴."""
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


_MIG_0381 = _load_migration_module("0381_preset_marketing_video_production_recipe.py", "_m0381_4149")
_MIG_0382 = _load_migration_module(
    "0382_recipe_video_production_structure_and_budget_gates.py", "_m0382_4149",
)
_MIG_0387 = _load_migration_module(
    "0387_recipe_role_binding_channel_connection.py", "_m0387_4149",
)
_KEY = "preset.4149.video_production"
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

    org = Organization(id=uuid.uuid4(), name="Org4149", slug=slug)
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


async def _seed_human_member(session, org_id, project_id, *, display_name):
    """정책 지정 승인자용 — org owner와 별개인 사람 멤버(User.display_name 있음)."""
    from app.models.project import OrgMember
    from app.models.team import TeamMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x", display_name=display_name)
    session.add(user)
    await session.commit()
    member = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="admin")
    session.add(member)
    await session.commit()
    session.add(TeamMember(
        id=member.id, org_id=org_id, project_id=project_id, type="human", name=display_name, is_active=True,
    ))
    await session.commit()
    return member.id


async def _seed_system_publisher_teammember_shim(session, org_id, project_id):
    """test_4085/test_4090과 동형(발명 0) — team_members VIEW를 create_all이 못 만들어
    publish_preset_event의 시스템 발행자 resolve_member가 400으로 조용히 실패하는 것을
    막는다."""
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


async def _seed_story(session, org_id, project_id, *, assignee_id, title="AC1 승인자 절"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, assignee_id=assignee_id)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_KEY, org_id=None, name="영상 제작(4149 테스트)",
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


async def _self_description_message_for(session, agent_id, org_id, *, definition_key):
    """cycle 자기설명 멘션("[이벤트] {definition_key}" 프리픽스)만 콕 집는다 — 같은
    발행이 gate 생성으로 approver에게 "'...' 결재 요청" 카드도 같이 쏘는데, 댄도
    work_item_stakeholders 브로드캐스트 대상이라 latest만으론 그 카드를 집을 수 있다
    (실측: created_at desc 1순위가 결재요청 카드였다)."""
    from app.models.conversation import Conversation, ConversationMessage, ConversationParticipant
    from sqlalchemy import select

    rows = (await session.execute(
        select(ConversationMessage)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == ConversationMessage.conversation_id)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(ConversationParticipant.member_id == agent_id, Conversation.org_id == org_id)
        .order_by(ConversationMessage.created_at.desc())
    )).scalars().all()
    prefix = f"[이벤트] {definition_key}"
    for row in rows:
        if row.content and row.content.startswith(prefix):
            return row.content
    return None


async def _publish_stage(s, *, key, story_id, org_id, stage, actor_id):
    from app.routers.events import EventPublishRequest, publish_registry_event

    payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)}
    await publish_registry_event(
        EventPublishRequest(definition_key=key, payload=payload),
        BackgroundTasks(), _fake_request(), db=s, auth=_auth(actor_id, org_id), org_id=org_id,
    )


# ─── AC1 — stage 진입 멘션의 승인자 절 ────────────────────────────────────────


@pytest.mark.anyio
async def test_ac1_stage_entry_mention_shows_policy_designated_approver_name():
    """정책 지정 O — #4083 OrgGatePolicy가 지정한 멤버 표시명이 «승인자: {name}(정책
    지정)» 형태로 멘션에 실린다. "org_owner" 리터럴 노출 0."""
    from app.models.hitl_config import OrgGatePolicy

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4149a")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)
            await _seed_definition(s)
            await _seed_preset_gate_verdict_definition(s)

            policy_approver_id = await _seed_human_member(s, org_id, project_id, display_name="마케팅담당자")
            s.add(OrgGatePolicy(id=uuid.uuid4(), org_id=org_id, recipe_gate_default_approver_member_id=policy_approver_id))
            await s.commit()

            await _publish_stage(s, key=_KEY, story_id=story_id, org_id=org_id, stage="draft", actor_id=creator_id)
            await _publish_stage(s, key=_KEY, story_id=story_id, org_id=org_id, stage="concept_confirmed", actor_id=creator_id)
            # concept_approval 게이트가 이 시점에 이미 열려 있다 — "concept_confirmed"
            # 발행 자체가 그 stage(다음 stage=concept_confirmed 아님, 실은 concept_
            # confirmed가 다음 gate를 연 stage) 셀프 설명 멘션을 만든다. animatic 이전
            # concept_confirmed 자신의 gate 선언(concept_approval)이 스코프 B다.
            content = await _self_description_message_for(s, creator_id, org_id, definition_key=_KEY)
            assert content is not None, "concept_confirmed 발행 직후 댄에게 도달한 자기설명 멘션이 없다"
            assert "org_owner" not in content, f"내부 role 슬러그가 문장에 그대로 샜다: {content!r}"
            assert f"승인자: 마케팅담당자(정책 지정)" in content, (
                f"정책 지정 승인자 표시명이 안 실렸다: {content!r}"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac1_stage_entry_mention_falls_back_to_org_owner_role_when_no_policy():
    """정책 미지정(기본값) — 기존 org owner 폴백 그대로, «승인자 역할: org 소유자»
    (한글 완성 문장, "org_owner" 슬러그 리터럴 아님)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4149b")
            await _seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)
            await _seed_definition(s)
            await _seed_preset_gate_verdict_definition(s)
            # OrgGatePolicy 행 자체를 안 만든다(미설정 — 기본값 그대로).

            await _publish_stage(s, key=_KEY, story_id=story_id, org_id=org_id, stage="draft", actor_id=creator_id)
            await _publish_stage(s, key=_KEY, story_id=story_id, org_id=org_id, stage="concept_confirmed", actor_id=creator_id)

            content = await _self_description_message_for(s, creator_id, org_id, definition_key=_KEY)
            assert content is not None
            assert "org_owner" not in content, f"내부 role 슬러그가 문장에 그대로 샜다: {content!r}"
            assert "승인자 역할: org 소유자" in content, f"기본 폴백 문구가 안 실렸다: {content!r}"
            assert "정책 지정" not in content
    finally:
        await engine.dispose()


# ─── AC2 — external_publish verdict 「다음 행동」이 실제 자동발행 결과를 반영 ──────


@pytest.mark.anyio
async def test_ac2_recipe_unscoped_gate_verdict_reflects_auto_publish_outcome():
    """gate_row 자신이 unscoped(scope_key="") 레시피 external_publish 게이트고
    publish_outcome이 이미 채워져 있으면(#4090/#4142 자동발행 훅, 같은 트랜잭션) —
    새 조회 없이 그 값을 그대로 읽어 "다음 행동" 문구가 실제 동작(자동 발행)을
    반영한다. #4142가 고친 축(gate_row가 scoped인 경우 역방향 조회)과 다른 축."""
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4149c")
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)

            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="external_publish", scope_key="", status="approved",
                publish_outcome="published",
            )
            s.add(gate)
            await s.commit()

            content = await _render_gate_verdict_message(
                s, org_id=org_id,
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "external_publish", "verdict": "approved", "gate_id": str(gate.id),
                },
            )
            assert "휴먼이 화면에서" not in content, f"거짓 human-only 문구가 여전히 있다: {content!r}"
            assert "자동 발행됐어요" in content, f"실제 자동발행 결과 문구가 안 실렸다: {content!r}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ac2_non_recipe_unscoped_external_publish_gate_unaffected_regression():
    """회귀 음성대조 — publish_outcome이 없는(레시피 무관, 사람이 직접 눌러야 하는)
    unscoped external_publish 게이트는 기존 human_only 문구 그대로(과잉적용 방지)."""
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug="4149d")
            creator_id = await _seed_agent(s, org_id, project_id, name="댄")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=creator_id)

            gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="external_publish", scope_key="", status="approved",
                publish_outcome=None,
            )
            s.add(gate)
            await s.commit()

            content = await _render_gate_verdict_message(
                s, org_id=org_id,
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "external_publish", "verdict": "approved", "gate_id": str(gate.id),
                },
            )
            assert "휴먼이 화면에서" in content, f"publish_outcome 없는 게이트까지 자동발행 문구가 새면 안 된다: {content!r}"
    finally:
        await engine.dispose()
