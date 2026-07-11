"""E-SECURITY SEC-S8(story 83ea3d6a) BB: workflow_templates apply + workflow_executions
story-summary project-scope 미검증 봉쇄 실증(까심 전수스윕, 실HTTP 확定).

- apply_template: body.project_id에 has_project_access 검증 자체가 없어, project_a만
  grant된 caller가 project_b로 template apply 시 실제로 AgentRoutingRule이 생성됐다(201).
- story_execution_summary: project_id에 project 접근권 검증이 없어 남의 project 워크플로
  실행 상태(story-level status/rule_name)가 노출됐다(200)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_base(session):
    """org(project_a, project_b) + human_a(project_a에만 명시 grant)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"h-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "human_user_id": human_user_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ── apply_template ───────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_apply_template_cross_project_blocked_no_rule_created():
    """BB 재현: project_a만 grant된 caller가 project_b로 template apply → 404·룰 생성 0."""
    from app.main import app
    from app.models.agent_routing_rule import AgentRoutingRule
    from app.models.member import Member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            agent = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="agent", is_active=True)
            s.add(agent)
            await s.commit()
            agent_id = agent.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow-templates/solo/apply",
                json={
                    "project_id": str(seeded["project_b_id"]),
                    "role_mapping": {"step_1": str(agent_id)},
                },
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            rules = (await s.execute(
                select(AgentRoutingRule).where(AgentRoutingRule.project_id == seeded["project_b_id"])
            )).scalars().all()
            assert rules == [], "무권한 project에 AgentRoutingRule이 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_template_same_project_still_works():
    from app.main import app
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            agent = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="agent", is_active=True)
            s.add(agent)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_a_id"], member_id=agent.id,
                permission="granted", role="member",
            ))
            await s.commit()
            agent_id = agent.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow-templates/solo/apply",
                json={
                    "project_id": str(seeded["project_a_id"]),
                    "role_mapping": {"step_1": str(agent_id)},
                },
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["rules_created"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── story_execution_summary ──────────────────────────────────────────────────

@pytest.mark.anyio
async def test_story_execution_summary_cross_project_blocked():
    """BB 재현: project_a만 grant된 caller가 project_b의 실행 요약 조회 → 404·노출 0."""
    from app.main import app
    from app.models.workflow_execution_log import WorkflowExecutionLog

    engine, Session = await _session_factory()
    try:
        story_id = str(uuid.uuid4())
        async with Session() as s:
            seeded = await _seed_base(s)
            s.add(WorkflowExecutionLog(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"],
                event_type="story.status_changed", status="success",
                event_context={"metadata": {"story_id": story_id}},
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/workflow-executions/story-summary",
                params={"project_id": str(seeded["project_b_id"]), "story_ids": [story_id]},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_execution_summary_same_project_still_works():
    from app.main import app
    from app.models.workflow_execution_log import WorkflowExecutionLog

    engine, Session = await _session_factory()
    try:
        story_id = str(uuid.uuid4())
        async with Session() as s:
            seeded = await _seed_base(s)
            s.add(WorkflowExecutionLog(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"],
                event_type="story.status_changed", status="success",
                event_context={"metadata": {"story_id": story_id}},
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/workflow-executions/story-summary",
                params={"project_id": str(seeded["project_a_id"]), "story_ids": [story_id]},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert story_id in body
            assert body[story_id]["status"] == "success"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
