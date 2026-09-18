"""story #3293(도메인탈고정 축2-ⓒ §B) — GET /api/v2/events/definitions/{id}/bindings.

축2-ⓐ(story #3288, PR#3686 MERGED)는 apply(쓰기)만 만들었다 — 갤러리 FE가 "이미
배정됨" 배지·기존 role_mapping 프리필을 하려면 이 read가 필요(doc
axis2c-gallery-migration-map-and-design §3-B). 검증 축:
- project_id 지정 시 그 project 바인딩이 org 전역보다 우선(병합 뷰).
- project_id 미지정 시 org 전역 바인딩만.
- 미배정 stage는 응답에 아예 안 실림(빈 dict 항목 아님).
- has_project_access 없는 project_id 조회는 404(SSOT require_project_access 재사용).
"""
from __future__ import annotations

import uuid

import pytest

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
_ROUTING = {
    "escalation": {"kind": "recipe_role_binding"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


async def _seed_org_project(session, *, slug="axis2c"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3293", slug=slug)
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


async def _seed_human_caller(session, org_id, project_id, *, name="caller"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_cyclic_definition(session, *, key="preset.axis2c.recipe_test"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None, payload_schema=_CYCLIC_PAYLOAD_SCHEMA, routing=_ROUTING,
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_project_binding_wins_over_org_wide_in_read_view():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings, get_recipe_role_bindings,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            org_wide_agent = await _seed_agent(s, org_id, project_id, name="org-wide")
            project_agent = await _seed_agent(s, org_id, project_id, name="project-specific")

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"step_1": str(org_wide_agent)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(project_agent)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )

            resp = await get_recipe_role_bindings(
                definition.id, project_id, db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.bindings == {"step_1": str(project_agent)}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_project_id_returns_org_wide_only():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings, get_recipe_role_bindings,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            org_wide_agent = await _seed_agent(s, org_id, project_id, name="org-wide")
            project_agent = await _seed_agent(s, org_id, project_id, name="project-specific")

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"step_1": str(org_wide_agent)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_2": str(project_agent)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )

            resp = await get_recipe_role_bindings(
                definition.id, None, db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.bindings == {"step_1": str(org_wide_agent)}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_unassigned_stage_absent_from_response():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings, get_recipe_role_bindings,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_cyclic_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            agent_id = await _seed_agent(s, org_id, project_id)

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"step_1": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )

            resp = await get_recipe_role_bindings(
                definition.id, project_id, db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert "step_2" not in resp.bindings
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_project_access_rejected_404():
    from fastapi import HTTPException

    from app.routers.events import get_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org_project(s, slug="axis2c-sec-a")
            from app.models.project import Project
            project_b = Project(id=uuid.uuid4(), org_id=org_id, name="P-B")
            s.add(project_b)
            await s.commit()

            definition = await _seed_cyclic_definition(s)
            outsider_id = await _seed_agent(s, org_id, project_a, name="outsider")

            with pytest.raises(HTTPException) as ei:
                await get_recipe_role_bindings(
                    definition.id, project_b.id, db=s, auth=_auth(outsider_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()
