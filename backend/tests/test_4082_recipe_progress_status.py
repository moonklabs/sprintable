"""story #4082([E-RECIPE-1] 레시피 진행 위치를 사람이 «켜면 보게») — 스토리 패널 «시작됨»
확장(현재 stage·다음 역할·마지막 발행 시각)·결재함 stage 표기.

AC1 — 시작된 스토리에서 현재 단계(역할)·다음 단계(역할)·마지막 발행 시각이 이력 SSOT
(conversation_messages) 기반으로 나온다. 시작 전엔 무변(#4075 그대로).
AC2 — 레시피 게이트 neutral_facts에 stage_role이 실린다(비레시피 게이트 무변 — 이 훅
자체가 stage_metadata[stage].gate 선언이 없으면 no-op이라 구조적으로 회귀 0).
AC3 — 9단계 정의로 3단계까지 발행 뒤 조회: 현재/다음/시각 정확·마지막 단계면
next_stage=None."""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema
_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
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


async def _seed_org_project_owner(session, *, slug="e4082"):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org4082", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(owner_user)
    await session.commit()
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user.id, role="owner")
    session.add(owner_member)
    await session.commit()
    session.add(TeamMember(
        id=owner_member.id, org_id=org.id, project_id=project.id, type="human", name="owner", is_active=True,
    ))
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="S"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}

_NINE_STAGES = [f"stage{i}" for i in range(1, 10)]


def _nine_stage_definition_fixtures(*, key="org.e4082.nine"):
    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["work_item_type", "work_item_id", "stage"],
        "properties": {
            "work_item_type": {"type": "string"},
            "work_item_id": {"type": "string", "format": "uuid"},
            "stage": {"type": "string", "enum": _NINE_STAGES},
        },
    }
    stage_metadata = {s: {"role": f"Role{i}", "action": f"{s} 작업"} for i, s in enumerate(_NINE_STAGES, start=1)}
    return schema, stage_metadata


async def _seed_definition(session, *, org_id, key, schema, stage_metadata):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name="테스트 레시피",
        payload_schema=schema, routing=_NONE_ROUTING, stage_metadata=stage_metadata,
        enabled=True, version=1,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_role_binding(session, *, org_id, project_id, definition_key, stage, agent_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=definition_key, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


def _auth(member_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )


async def _publish_stage(session, *, org_id, definition_key, story_id, stage, requester_id):
    from app.routers.events import _publish_registry_event_core

    return await _publish_registry_event_core(
        session, org_id, _auth(requester_id, org_id), definition_key,
        {"work_item_type": "story", "work_item_id": str(story_id), "stage": stage},
        BackgroundTasks(),
    )


async def _get_candidates(session, *, org_id, project_id, story_id, user_id):
    from app.routers.events import get_recipe_start_candidates

    return await get_recipe_start_candidates(
        project_id, work_item_type="story", work_item_id=story_id,
        db=session, auth=_auth(user_id, org_id), org_id=org_id,
    )


# ─── AC1/AC3: 진행 위치 필드 ────────────────────────────────────────────────

@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac1_not_started_progress_fields_are_none():
    """negative — 시작 전엔 #4075 그대로(진행 필드 전부 None, 회귀 0)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            schema, stage_metadata = _nine_stage_definition_fixtures()
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.nine", schema=schema, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage="stage1", agent_id=agent_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            c = resp.candidates[0]
            assert c.started is False
            assert c.current_stage is None
            assert c.current_role is None
            assert c.next_stage is None
            assert c.next_role is None
            assert c.last_published_at is None
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac1_started_at_first_stage_shows_current_and_next():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            schema, stage_metadata = _nine_stage_definition_fixtures()
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.nine", schema=schema, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage="stage1", agent_id=agent_id)

            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="stage1", requester_id=owner_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            c = resp.candidates[0]
            assert c.started is True
            assert c.current_stage == "stage1"
            assert c.current_role == "Role1"
            assert c.next_stage == "stage2"
            assert c.next_role == "Role2"
            assert c.last_published_at is not None
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac3_nine_stage_definition_published_to_stage3_reports_current_next_and_time():
    """AC3 그대로 — 9단계 정의, 3단계까지 발행 뒤 조회."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            schema, stage_metadata = _nine_stage_definition_fixtures()
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.nine", schema=schema, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage="stage1", agent_id=agent_id)

            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="stage1", requester_id=owner_id)
            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="stage2", requester_id=owner_id)
            third = await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="stage3", requester_id=owner_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            c = resp.candidates[0]
            assert c.started is True  # dedup 판정(첫 stage)은 stage1 발행 여부로 무변
            assert c.current_stage == "stage3"
            assert c.current_role == "Role3"
            assert c.next_stage == "stage4"
            assert c.next_role == "Role4"

            from sqlalchemy import select
            from app.models.conversation import ConversationMessage
            third_msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(third["message_id"]))
            )).scalar_one()
            assert c.last_published_at == third_msg.created_at
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac1_last_stage_reports_no_next_stage():
    """negative — 마지막 stage 발행 뒤엔 next_stage=None(BE는 "마지막 단계" 문구를 안
    만든다 — 그건 FE 표시몫, AC1 문서 그대로)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            schema, stage_metadata = _nine_stage_definition_fixtures()
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.nine", schema=schema, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_role_binding(s, org_id=org_id, project_id=project_id, definition_key=definition.key, stage="stage1", agent_id=agent_id)

            for stage in _NINE_STAGES:
                await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage=stage, requester_id=owner_id)

            resp = await _get_candidates(s, org_id=org_id, project_id=project_id, story_id=story_id, user_id=owner_id)
            c = resp.candidates[0]
            assert c.current_stage == "stage9"
            assert c.next_stage is None
            assert c.next_role is None
    finally:
        await engine.dispose()


# ─── AC2: 게이트 neutral_facts.stage_role ─────────────────────────────────

_GATED_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["work_item_type", "work_item_id", "stage"],
    "properties": {
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "stage": {"type": "string", "enum": ["draft", "review"]},
    },
}


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac2_gate_neutral_facts_includes_stage_role_when_declared():

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            stage_metadata = {
                "draft": {"role": "Writer", "action": "초안"},
                "review": {
                    "role": "Reviewer", "action": "검토",
                    "gate": {"type": "concept", "approver": "org_owner"},
                },
            }
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.gated", schema=_GATED_SCHEMA, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)

            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="draft", requester_id=owner_id)
            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="review", requester_id=owner_id)

            from sqlalchemy import select
            from app.models.gate import Gate
            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept")
            )).scalars().first()
            assert gate is not None, "review stage가 gate 선언을 가졌는데 게이트가 안 생겼다"
            assert gate.neutral_facts.get("stage") == "review"
            assert gate.neutral_facts.get("stage_role") == "Reviewer"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_ac2_gate_neutral_facts_omits_stage_role_when_role_not_declared():
    """negative — role 키가 없는 stage_metadata(레거시 형)면 stage_role 자체를 안
    싣는다(빈 문자열 폴백 금지, 파일 헤더 docstring 원칙)."""

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_id = await _seed_org_project_owner(s)
            stage_metadata = {
                "draft": {"role": "Writer", "action": "초안"},
                "review": {"action": "검토", "gate": {"type": "concept", "approver": "org_owner"}},
            }
            definition = await _seed_definition(s, org_id=org_id, key="org.e4082.gated_norole", schema=_GATED_SCHEMA, stage_metadata=stage_metadata)
            story_id = await _seed_story(s, org_id, project_id)

            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="draft", requester_id=owner_id)
            await _publish_stage(s, org_id=org_id, definition_key=definition.key, story_id=story_id, stage="review", requester_id=owner_id)

            from sqlalchemy import select
            from app.models.gate import Gate
            gate = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == "concept")
            )).scalars().first()
            assert gate is not None
            assert "stage_role" not in gate.neutral_facts
    finally:
        await engine.dispose()
