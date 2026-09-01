"""M2(마케팅 자동화, story #3293 계열) — [M2 마케팅 콘텐츠 파이프라인 스펙](entity:doc:
069927ad-6b3d-41ea-bac8-6a5e8735668b) §④ AC3: "실사용 0건이던 recipe_role_binding routing
실경로 확認"(PO 지시, 2026-09-01) — `routing.broadcast.kind="recipe_role_binding"`(story
#3288)가 이 코드베이스에서 실제로 한 번도 안 쓰인 채(라이브 org 커스텀 5건+프리셋 14건 전수
조회로 실측 확認, 위 doc §정정②) 등록만 돼 있었다. 이 파일이 그 첫 실사용 pin이다.

⭐이 파일은 "스캐폴드"다(PO 지시: 등록되면 바로 실경로 붙게 테스트 골격만 먼저) — org 커스텀
등록은 PO가 owner 자격으로 live dev에 별도로 한다(디디는 member라 REST 등록 불가, doc §③).
이 파일은 그 등록과 무관하게 **자기 완결적으로**(disposable PG에 정확히 같은 shape의
EventDefinition을 직접 seed) 라우팅 메커니즘 자체를 지금 pin한다 — test_2633_event_publish.py
의 확립된 realdb 하네스(seed 헬퍼 전부 재사용, 발명 0)를 그대로 쓴다. PO의 live dry-run(실제
등록된 definition_id로 dev에서 한 번 더 확認)은 이 pin과 별개, 보완 관계다.

payload_schema/routing/stage_metadata는 위 doc §①의 확定 스펙과 **정확히 일치**시켰다 —
그래야 이 pin이 "PO가 실제로 등록할 그 모양"을 미리 검증하는 게 된다.
"""
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

_DEFINITION_KEY = "org.moonklabs.marketing_content_pipeline"

# doc 069927ad §① 그대로.
_PAYLOAD_SCHEMA = {
    "type": "object",
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["monitor", "research", "draft", "approve", "publish", "measure"]},
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
    "monitor": {"role": "Agent", "action": "주제·신호 감지, 후보 콘텐츠 아이디어 수집"},
    "research": {"role": "Agent", "action": "선정 주제 리서치, 근거·참고자료 수집"},
    "draft": {"role": "Agent", "action": "이메일 캠페인 초안 작성(제목·본문)"},
    "approve": {"role": "Human", "action": "초안 검토 후 external_publish 게이트 승인/반려"},
    "publish": {"role": "Agent", "action": "승인분만 스티비 커넥터로 실 발행"},
    "measure": {"role": "Agent", "action": "발행 결과·성과를 evidence로 기록"},
}


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


async def _seed_org_project(session, *, slug="m2marketing"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="OrgM2", slug=slug)
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

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="캠페인 work item")
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session, org_id):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_DEFINITION_KEY, org_id=org_id, name="마케팅 콘텐츠 파이프라인",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
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


# ── ⭐핵심 pin — 첫 실사용: project 스코프 바인딩이 실제로 broadcast 대상을 결정한다 ──────


@pytest.mark.anyio
async def test_recipe_role_binding_resolves_project_scoped_binding():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=drafter_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="draft")

            assert resp["broadcast_member_ids"] == [str(drafter_id)]
            assert resp["escalation_member_ids"] == []  # target=none
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_role_binding_project_scope_wins_over_org_scope():
    """resolver의 우선순위 계약(event_routing_resolver.py::_resolve_recipe_role_binding —
    "project 스코프가 org 전역보다 우선")을 실측으로 고정 — org 전역 바인딩과 project 전용
    바인딩이 동시에 있을 때 project 쪽이 이긴다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            org_wide_id = await _seed_agent(s, org_id, project_id, name="org-wide-drafter")
            project_specific_id = await _seed_agent(s, org_id, project_id, name="project-drafter")
            story_id = await _seed_story(s, org_id, project_id)

            from app.models.recipe_role_binding import RecipeRoleBinding
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=None,
                event_definition_key=_DEFINITION_KEY, stage="draft", agent_member_id=org_wide_id,
            ))
            await s.commit()
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=project_specific_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="draft")

            assert resp["broadcast_member_ids"] == [str(project_specific_id)]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_role_binding_falls_back_to_org_wide_when_no_project_binding():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            org_wide_id = await _seed_agent(s, org_id, project_id, name="org-wide-approver")
            story_id = await _seed_story(s, org_id, project_id)

            from app.models.recipe_role_binding import RecipeRoleBinding
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=None,
                event_definition_key=_DEFINITION_KEY, stage="approve", agent_member_id=org_wide_id,
            ))
            await s.commit()

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="approve")

            assert resp["broadcast_member_ids"] == [str(org_wide_id)]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_role_binding_unbound_stage_returns_empty_not_crash():
    """⭐PO 확定 「모르면 안 준다」(event_routing_resolver.py 주석 그대로) — 바인딩 없는
    stage는 500도, 엉뚱한 이해관계자로의 유실도 아니라 빈 broadcast로 정직하게 실패-안전."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)
            # 어떤 stage에도 바인딩을 안 심는다 — role_mapping apply 이전 상태 재현.

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="monitor")

            assert resp["broadcast_member_ids"] == []
            assert resp["escalation_member_ids"] == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_role_binding_only_binds_the_requested_stage_not_others():
    """스테이지 간 교차오염 방지 — draft에만 바인딩해도 monitor 발행엔 새지 않는다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_binding(s, org_id, project_id, stage="draft", agent_id=drafter_id)

            resp = await _publish_stage(s, org_id=org_id, publisher_id=publisher_id, story_id=story_id, stage="monitor")

            assert resp["broadcast_member_ids"] == []
    finally:
        await engine.dispose()
