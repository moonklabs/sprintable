"""E-VERIFY V0-S1(story 5a5ba27b): Evidence CRD API — 실 Postgres 검증.

team_members는 뷰(members⋈project_access)라 `resolve_member`/`has_project_access`의 에이전트
분기가 실동작하려면 실 Alembic 마이그(진짜 VIEW)가 필요 — create_all은 부적합
([[reference_local_migration_verify]] 패턴)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요 — alembic upgrade heads 적용된 DB"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """established pattern(test_a2a_sa1_deadline_sweeper_realdb.py) — 전역 engine cross-loop 방지."""
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


async def _seed(session):
    """org + project + agent(grant된) + story + task."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story, Task

    org = Organization(id=uuid.uuid4(), name="V0-S1 Org", slug=f"v0s1-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="V0-S1 Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Evidence Agent", is_active=True)
    other_agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Other Agent", is_active=True)
    session.add_all([project, agent, other_agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    other_grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=other_agent.id, permission="granted", role="member",
    )
    session.add_all([grant, other_grant])

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="V0-S1 Story", status="in-progress")
    session.add(story)
    await session.commit()

    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="V0-S1 Task", status="in-progress")
    session.add(task)
    await session.commit()

    return org.id, project.id, agent.id, other_agent.id, story.id, task.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _auth_override(member_id, org_id):
    async def _auth():
        from app.dependencies.auth import AuthContext
        # api_key_id 신호가 있어야 resolve_member가 agent(API키) 분기로 간다([[feedback_actor_type_failclosed]]).
        return AuthContext(
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )
    return _auth


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            yield s

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth_override(member_id, org_id)
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_create_and_list_evidence_on_story():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, _other_id, story_id, _task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "pr", "ref": "https://github.com/org/repo/pull/1", "source": "github",
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["type"] == "pr"
            assert body["created_by"] == str(agent_id)

            list_resp = await client.get(
                "/api/v2/evidence", params={"work_item_id": str(story_id), "work_item_type": "story"}
            )
            assert list_resp.status_code == 200
            items = list_resp.json()
            assert len(items) == 1
            assert items[0]["ref"] == "https://github.com/org/repo/pull/1"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_evidence_on_task_resolves_project_via_story():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, _other_id, _story_id, task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(task_id), "work_item_type": "task",
                "type": "deploy", "ref": "https://console.cloud.google.com/run/deploy/1",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_approval_type_rejected_from_public_api():
    """스푸핑 방지 — gate_approval은 시스템 전용, 공개 API로 직접 생성 400."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, _other_id, story_id, _task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "gate_approval", "ref": "fake-approval",
            })
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_project_access_forbidden():
    """target project에 grant 없는 에이전트는 403(mutation 대상 project-scope 강제) — stranger는
    *다른* project에 grant를 둬 resolve_member(team_members 뷰 조회)는 통과시키고, has_project_access
    단독으로 걸리게 격리한다(완전 무-grant agent는 team_members 뷰에 행 자체가 없어 resolve_member가
    먼저 400으로 죽어 이 403 경로를 못 격리 — 실측으로 확認된 별개 계층)."""
    from app.main import app
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, _other_id, story_id, _task_id = await _seed(s)
            other_project = Project(id=uuid.uuid4(), org_id=org_id, name="Other Project")
            stranger = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name="Stranger", is_active=True)
            s.add_all([other_project, stranger])
            await s.commit()
            stranger_grant = ProjectAccess(
                id=uuid.uuid4(), project_id=other_project.id, member_id=stranger.id,
                permission="granted", role="member",
            )
            s.add(stranger_grant)
            await s.commit()
            stranger_id = stranger.id

        await _setup_app(app, Session, stranger_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "url", "ref": "https://example.com",
            })
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_by_creator_succeeds_by_other_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, other_agent_id, story_id, _task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        evidence_id = None
        try:
            create_resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "report", "ref": "https://example.com/report",
            })
            evidence_id = create_resp.json()["id"]

            # 타인(다른 agent)이 삭제 시도 → 403
            app.dependency_overrides.clear()
            await _setup_app(app, Session, other_agent_id, org_id)
            forbidden_resp = await client.delete(f"/api/v2/evidence/{evidence_id}")
            assert forbidden_resp.status_code == 403, forbidden_resp.text

            # 생성자 본인은 삭제 성공
            app.dependency_overrides.clear()
            await _setup_app(app, Session, agent_id, org_id)
            ok_resp = await client.delete(f"/api/v2/evidence/{evidence_id}")
            assert ok_resp.status_code == 204, ok_resp.text

            list_resp = await client.get(
                "/api/v2/evidence", params={"work_item_id": str(story_id), "work_item_type": "story"}
            )
            assert list_resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
