"""E-SECURITY SEC-S8(story 83ea3d6a) Z2: workflow_report/workflow_trigger project-scope
미검증 봉쇄 실증(까심 전수스윕, 실HTTP 확定).

- report_done: org-scope(#12)는 있으나 has_project_access 부재 — project_a만 grant된 caller가
  project_b story_id로 report-done 호출 시 story.status가 실제로 변조됐다(backlog→in-progress).
- trigger_workflow: body.project_id에 has_project_access 검증 자체가 없어 project_b 전용
  enabled rule이 실제로 매치되고 WorkflowExecutionLog가 생성됐다(남의 project 워크플로 트리거)."""
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


# ── report_done ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_report_done_cross_project_blocked_no_mutation():
    """Z2 재현: project_a만 grant된 caller가 project_b story로 report-done → story 무변조."""
    from app.main import app
    from app.models.member import Member
    from app.models.pm import Story
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_b = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_b_id"], title="Story B", status="backlog")
            agent = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="agent", is_active=True)
            s.add_all([story_b, agent])
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=seeded["project_a_id"], member_id=agent.id, permission="granted", role="member"))
            await s.commit()
            story_b_id, agent_id = story_b.id, agent.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow/report-done",
                json={"story_id": str(story_b_id), "stage": "kickoff", "agent_id": str(agent_id)},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            reloaded = (await s.execute(select(Story).where(Story.id == story_b_id))).scalar_one()
            assert reloaded.status == "backlog", "무권한 project story 상태가 변조되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_report_done_same_project_still_works():
    from app.main import app
    from app.models.member import Member
    from app.models.pm import Story
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            story_a = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], title="Story A", status="backlog")
            agent = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="agent", name="agent", is_active=True)
            s.add_all([story_a, agent])
            await s.commit()
            s.add(ProjectAccess(id=uuid.uuid4(), project_id=seeded["project_a_id"], member_id=agent.id, permission="granted", role="member"))
            await s.commit()
            story_a_id, agent_id = story_a.id, agent.id

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow/report-done",
                json={"story_id": str(story_a_id), "stage": "kickoff", "agent_id": str(agent_id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["story_status"] == "in-progress"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── trigger_workflow ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_trigger_workflow_cross_project_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow/trigger",
                json={
                    "project_id": str(seeded["project_b_id"]), "story_id": str(uuid.uuid4()),
                    "trigger_type_slug": "kickoff",
                },
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.workflow_execution_log import WorkflowExecutionLog
            logs = (await s.execute(
                select(WorkflowExecutionLog).where(WorkflowExecutionLog.project_id == seeded["project_b_id"])
            )).scalars().all()
            assert logs == [], "무권한 project에 워크플로 실행 로그가 생성되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_trigger_workflow_same_project_still_works():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/workflow/trigger",
                json={
                    "project_id": str(seeded["project_a_id"]), "story_id": str(uuid.uuid4()),
                    "trigger_type_slug": "kickoff",
                },
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] in ("no_match", "triggered")
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
