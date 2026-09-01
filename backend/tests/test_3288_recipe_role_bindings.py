"""story #3288(도메인탈고정 축2-ⓐ) — 레시피 apply 계층: EventDefinition.stage_metadata.role
(표시 텍스트뿐)을 실제 org/project TeamMember에 바인딩해, routing 해석기가 발행 시점에 그
stage의 실제 담당 에이전트를 조회할 수 있게 한다.

doc axis2-recipe-mechanism-event-definitions-design §설계정정 — AgentRoutingRule 재사용은
폐기(rule_evaluator.py가 구세대 trigger 어휘 전용이라 신세대 트리거를 절대 못 읽음). 신세대
"자동화" = 알림→에이전트가 action을 지시로 읽고 스스로 행동. 이 스토리는 그 알림의 수신자를
정확히 만드는 recipe_role_bindings+routing kind만 다룬다(side-effect 자동집행 아님).

검증 축:
- AC1: 테이블/모델 — org 전역 vs project 특이성 스코프 분리(부분 unique index).
- AC2: routing kind="recipe_role_binding" — 실 발행으로 바인딩된 에이전트가 route_message
  수신자에 포함되는지 실증.
- AC3: apply 엔드포인트 — 구 apply_template 검증체인(has_project_access·stage 검증·org
  스코프 agent 검증) 이식 확인.
- AC4: 「모르면 안 준다」 — 바인딩 없는 stage는 빈 집합(다른 이해관계자로 새지 않음).
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


_CYCLIC_PAYLOAD_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["step_1", "step_2"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_RECIPE_ROLE_BINDING_ROUTING = {
    "escalation": {"kind": "recipe_role_binding"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_org_project(session, *, slug="axis2a"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3288", slug=slug)
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


async def _seed_human_caller(session, org_id, project_id, *, name="caller"):
    """has_project_access의 team_member_branch는 type='human'만 통과시킨다(project_auth.py
    _project_access_predicate 실측) — apply 엔드포인트 호출자는 이 타입으로 seed."""
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S")
    session.add(story)
    await session.commit()
    return story.id


async def _seed_cyclic_definition(session, *, key="preset.axis2a.recipe_test"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None, payload_schema=_CYCLIC_PAYLOAD_SCHEMA,
        routing=_RECIPE_ROLE_BINDING_ROUTING,
        stage_metadata={"step_1": {"role": "Developer", "action": "do the thing"},
                        "step_2": {"role": "Reviewer", "action": "review the thing"}},
    )
    session.add(d)
    await session.commit()
    return d


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request():
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


# ─── registry: routing kind validation ─────────────────────────────────────

def test_registry_accepts_recipe_role_binding_kind_bare():
    from app.services.event_definition_registry import validate_event_routing

    validate_event_routing({
        "escalation": {"kind": "recipe_role_binding"},
        "broadcast": {"kind": "server_derived", "target": "none"},
    })


def test_registry_rejects_recipe_role_binding_with_extra_params():
    from app.services.event_definition_registry import InvalidEventRoutingError, validate_event_routing

    with pytest.raises(InvalidEventRoutingError):
        validate_event_routing({
            "escalation": {"kind": "recipe_role_binding", "target": "none"},
            "broadcast": {"kind": "server_derived", "target": "none"},
        })


# ─── AC2/AC4: 해석기 — 바인딩 있으면 그 에이전트, 없으면 빈 집합(모르면 안 준다) ──────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_routes_to_bound_agent_via_apply_endpoint():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, EventPublishRequest,
        apply_recipe_role_bindings, publish_registry_event,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")
            developer_id = await _seed_agent(s, org_id, project_id, name="dev")
            story_id = await _seed_story(s, org_id, project_id)

            apply_resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(developer_id)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert apply_resp.ok and apply_resp.bindings_upserted == 1

            body = EventPublishRequest(
                definition_key=definition.key,
                payload={"stage": "step_1", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(developer_id)]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unassigned_stage_yields_no_escalation_no_leak():
    """PO 확定 「모르면 안 준다」 — step_2에 바인딩이 없으면 escalation은 빈 채로 나가야
    한다. **타 org의 같은 (definition_key, stage) 바인딩이 존재해도** 새지 않아야 한다 —
    org_id 필터가 빠지면 이 테스트가 정확히 그 누출을 잡는다(단순 "바인딩 0건" 케이스보다
    엄격: 리졸버가 org 스코프 없이 아무 매치나 집어오는 뮤테이션을 여기서 실제로 RED)."""
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, EventPublishRequest,
        apply_recipe_role_bindings, publish_registry_event,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="axis2a-leak-a")
            other_org_id, other_project_id = await _seed_org_project(s, slug="axis2a-leak-b")
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")
            developer_id = await _seed_agent(s, org_id, project_id, name="dev")
            story_id = await _seed_story(s, org_id, project_id)

            # step_1만 바인딩, step_2는 미배정으로 남긴다(이 org 안에서는).
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(developer_id)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            # 타 org가 같은 definition_key+stage="step_2"를 바인딩해둔다 — org 스코프가 실제로
            # 지켜지는지의 진짜 대조군(리졸버가 org_id를 빼먹으면 이게 새어 들어온다).
            other_publisher = await _seed_human_caller(s, other_org_id, other_project_id, name="other-publisher")
            other_agent = await _seed_agent(s, other_org_id, other_project_id, name="other-dev")
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(
                    project_id=other_project_id, role_mapping={"step_2": str(other_agent)},
                ),
                db=s, auth=_auth(other_publisher, other_org_id), org_id=other_org_id,
            )

            body = EventPublishRequest(
                definition_key=definition.key,
                payload={"stage": "step_2", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == []
            assert str(developer_id) not in resp["escalation_member_ids"]
            assert str(other_agent) not in resp["escalation_member_ids"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_project_scope_binding_wins_over_org_wide_binding():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, EventPublishRequest,
        apply_recipe_role_bindings, publish_registry_event,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")
            org_wide_agent = await _seed_agent(s, org_id, project_id, name="org-wide")
            project_agent = await _seed_agent(s, org_id, project_id, name="project-specific")
            story_id = await _seed_story(s, org_id, project_id)

            # org 전역 바인딩 먼저(project_id=None).
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"step_1": str(org_wide_agent)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            # 이 project 전용 바인딩(우선해야 함).
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(project_agent)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            body = EventPublishRequest(
                definition_key=definition.key,
                payload={"stage": "step_1", "work_item_type": "story", "work_item_id": str(story_id)},
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(project_agent)]
    finally:
        await engine.dispose()


# ─── AC3: apply 엔드포인트 검증체인 ──────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_rejects_unknown_stage():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")

            with pytest.raises(HTTPException) as ei:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(
                        project_id=project_id, role_mapping={"nonexistent_stage": str(publisher_id)},
                    ),
                    db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_rejects_cross_org_agent():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="axis2a-a")
            other_org_id, other_project_id = await _seed_org_project(s, slug="axis2a-b")
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")
            foreign_agent = await _seed_agent(s, other_org_id, other_project_id, name="foreign")

            with pytest.raises(HTTPException) as ei:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(
                        project_id=project_id, role_mapping={"step_1": str(foreign_agent)},
                    ),
                    db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_rejects_caller_without_project_access():
    """SEC-S8 CRITICAL 재발 방지(구 apply_template 사고 자리) — project 접근권 없는
    caller가 그 project에 바인딩을 심을 수 없어야 한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org_project(s, slug="axis2a-sec")
            from app.models.project import Project
            project_b = Project(id=uuid.uuid4(), org_id=org_id, name="P-B")
            s.add(project_b)
            await s.commit()

            # publisher는 project_a에만 소속(project_b엔 미소속·미권한).
            outsider_id = await _seed_agent(s, org_id, project_a, name="outsider")
            definition = await _seed_cyclic_definition(s)
            target_agent = await _seed_agent(s, org_id, project_b.id, name="target")

            with pytest.raises(HTTPException) as ei:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(
                        project_id=project_b.id, role_mapping={"step_1": str(target_agent)},
                    ),
                    db=s, auth=_auth(outsider_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_reapply_upserts_not_duplicates():
    """재적용(같은 stage, 다른 agent)은 새 행 추가가 아니라 갱신이어야 한다 — 부분 unique
    index가 실제로 이걸 강제하는지 확인(모델/마이그 정합성)."""
    from sqlalchemy import func, select

    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            publisher_id = await _seed_human_caller(s, org_id, project_id, name="publisher")
            agent_1 = await _seed_agent(s, org_id, project_id, name="agent-1")
            agent_2 = await _seed_agent(s, org_id, project_id, name="agent-2")

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(agent_1)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(agent_2)}),
                db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

            count = (await s.execute(
                select(func.count()).select_from(RecipeRoleBinding).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.project_id == project_id,
                    RecipeRoleBinding.event_definition_key == definition.key, RecipeRoleBinding.stage == "step_1",
                )
            )).scalar_one()
            assert count == 1

            bound = (await s.execute(
                select(RecipeRoleBinding.agent_member_id).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.project_id == project_id,
                    RecipeRoleBinding.event_definition_key == definition.key, RecipeRoleBinding.stage == "step_1",
                )
            )).scalar_one()
            assert bound == agent_2
    finally:
        await engine.dispose()
