"""story #4092(E-RECIPE-1 팔로우업, PO 확定 2026-09-21) — AC2/AC3 핵심 pin.

리허설 1호 실측: Director(사람) 역할 stage(concept_confirmed·structure_passed·
pending_approval)를 발행할 때마다 zero_reach 경고가 매번 떴다(그 stage는 애초 에이전트
바인딩이 없는 게 정상이므로). 정의가 role_actor_kinds(§b)로 role→human/agent를 선언하면
사람 역할 stage는 경고 대신 중립 안내로 대체된다 — 선언이 없으면("모름") 오늘과 동일.

realdb 하네스는 test_m2_recipe_role_binding_routing_realdb.py(recipe_role_binding
routing)와 test_2636_publish_zero_reach_warning.py(zero_reach 판정)의 확립된 셀프컨테인
seed 헬퍼를 그대로 복제(이 파일 자체 완결 — 관례 재발명 0)."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_DEFINITION_KEY = "org.acme.recipe_4092"

_PAYLOAD_SCHEMA = {
    "type": "object",
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "concept_confirmed"]},
        "work_item_id": {"type": "string", "format": "uuid"},
        "work_item_type": {"type": "string"},
    },
    "additionalProperties": False,
}
_ROUTING = {
    "broadcast": {"kind": "recipe_role_binding"},
    "escalation": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "초안 작성"},
    "concept_confirmed": {"role": "Director", "action": "컨셉 확定 승인"},
}
_ROLE_ACTOR_KINDS = {"Creator": "agent", "Director": "human"}


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


async def _seed_org_project(session, *, slug="s4092"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4092", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="레시피 work item")
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session, org_id, *, role_actor_kinds=None):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_DEFINITION_KEY, org_id=org_id, name="테스트 레시피",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
        role_actor_kinds=role_actor_kinds,
    )
    session.add(d)
    await session.commit()
    return d.id


async def _seed_binding(session, org_id, project_id, *, stage, agent_id):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=_DEFINITION_KEY, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def _publish_stage(session, *, org_id, publisher_id, story_id, stage):
    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(
        definition_key=_DEFINITION_KEY,
        payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
    )
    return await publish_registry_event(
        body, BackgroundTasks(), _fake_request(), db=session, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


@pytest.mark.anyio
async def test_human_role_stage_with_declared_kinds_gets_notice_not_warning():
    """⭐AC2/AC3 핵심 — role_actor_kinds 선언 + Director(human) stage, 바인딩 0건 →
    경고 대신 중립 안내."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)
            # concept_confirmed(Director) stage — 의도적으로 바인딩 0건(사람 stage라 정상).

            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="concept_confirmed",
            )

            assert resp["broadcast_member_ids"] == []
            assert resp["zero_reach_warning"] is False
            assert "warning" not in resp
            assert resp.get("notice") == "이 단계는 사람이 판단해요 — 에이전트 바인딩이 필요 없어요."
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_role_stage_without_binding_still_warns():
    """⭐AC3 — 같은 정의라도 Creator(agent) stage에서 바인딩이 없으면 여전히 경고(진짜
    갭 — 개선이 경고를 망가뜨리지 않는다는 음성대조)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)
            # draft(Creator) stage — 바인딩 0건, 이건 "진짜 갭".

            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="draft",
            )

            assert resp["broadcast_member_ids"] == []
            assert resp["zero_reach_warning"] is True
            assert "warning" in resp
            assert "notice" not in resp
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_role_stage_with_binding_no_warning_no_notice():
    """양성대조 — Creator(agent) stage에 바인딩이 있으면 경고도 안내도 없다(오늘과 동일,
    #4092가 정상 발행 경로를 안 건드림)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=_ROLE_ACTOR_KINDS)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=drafter_id)

            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="draft",
            )

            assert resp["broadcast_member_ids"] == [str(drafter_id)]
            assert resp["zero_reach_warning"] is False
            assert "warning" not in resp
            assert "notice" not in resp
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_role_stage_without_role_actor_kinds_declaration_still_warns():
    """⭐AC1/AC2 회귀 0 핵심 — role_actor_kinds 선언 자체가 없으면("모름", 레거시 정의
    전부) Director stage도 오늘과 동일하게 경고 그대로. 개선은 선언한 정의만."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id, role_actor_kinds=None)  # 선언 없음
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)

            resp = await _publish_stage(
                s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="concept_confirmed",
            )

            assert resp["zero_reach_warning"] is True
            assert "warning" in resp
            assert "notice" not in resp
    finally:
        await engine.dispose()
