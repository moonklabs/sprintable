"""E-SECURITY SEC-S1(확장, story 70c9e92c): delete_story와 동형으로 task/epic/doc/project
hard-delete도 휴먼 전용화 + 삭제 감사 — 까심 적대적 QA 발견 갭(story만 막고 나머지는 그대로라
prompt injection이 delete_epic/task/doc/project로 우회 가능했음) 봉쇄 실증."""
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


async def _seed(session, *, admin_role: str | None = None):
    """org + project + agent + human org_member(옵션 role) + task/epic/doc."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Epic, Story, Task
    from app.models.doc import Doc
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="SEC-S1-EXT Org", slug=f"sec-s1-ext-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="SEC-S1-EXT Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Deleting Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Anchor Story", status="backlog")
    session.add(story)
    await session.commit()

    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="To Be Deleted Task", status="todo")
    epic = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="To Be Deleted Epic")
    doc = Doc(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="To Be Deleted Doc", slug=f"doc-{uuid.uuid4().hex[:8]}")
    session.add_all([task, epic, doc])
    await session.commit()

    human_id = uuid.uuid4()
    user = User(id=human_id, email=f"human-{human_id}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_id, role=(admin_role or "member"))
    session.add(om)
    await session.commit()
    human_grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted",
    )
    session.add(human_grant)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "task_id": task.id, "epic_id": epic.id, "doc_id": doc.id,
        "human_user_id": human_id, "human_org_member_id": om.id,
    }


async def _seed_project_only(session, *, admin_role: str | None = None):
    """project delete 전용 최소 시드 — epic을 안 붙인다(project→epic FK가 ORM 세션에서
    session.delete(project) 시 CASCADE 대신 SET NULL UPDATE를 먼저 시도해 NOT NULL 위반나는
    사전 존재 버그를 이 테스트가 우연히 건드리는 것 회피. SEC-S1 스코프 밖이라 별도 플래그만)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="SEC-S1-EXT PrjOrg", slug=f"sec-s1-ext-p-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="SEC-S1-EXT Project Only")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Deleting Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))
    await session.commit()

    human_id = uuid.uuid4()
    user = User(id=human_id, email=f"human-{human_id}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_id, role=(admin_role or "member"))
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
        "human_user_id": human_id, "human_org_member_id": om.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, member_id, org_id, *, is_agent: bool):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if is_agent:
            claims["app_metadata"]["api_key_id"] = "test-key"
        return AuthContext(user_id=str(member_id), email="test@test", claims=claims)

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_agent_delete_task_forbidden():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"], is_agent=True)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/tasks/{seeded['task_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Task
            task = (await s.execute(select(Task).where(Task.id == seeded["task_id"]))).scalar_one_or_none()
            assert task is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_delete_task_succeeds_and_audit_logged():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/tasks/{seeded['task_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Task
            from app.models.deletion_audit import DeletionAuditLog
            task = (await s.execute(select(Task).where(Task.id == seeded["task_id"]))).scalar_one_or_none()
            assert task is None
            logs = (await s.execute(
                select(DeletionAuditLog).where(DeletionAuditLog.entity_id == seeded["task_id"])
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].entity_type == "task"
            assert logs[0].actor_id == seeded["human_org_member_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_delete_doc_forbidden():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"], is_agent=True)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/docs/{seeded['doc_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_delete_doc_succeeds_and_audit_logged():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/docs/{seeded['doc_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
        async with Session() as s:
            from sqlalchemy import select
            from app.models.deletion_audit import DeletionAuditLog
            logs = (await s.execute(
                select(DeletionAuditLog).where(DeletionAuditLog.entity_id == seeded["doc_id"])
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].entity_type == "doc"
            assert logs[0].actor_id == seeded["human_org_member_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_delete_epic_forbidden():
    """에이전트는 admin/owner role을 org_members에 절대 가질 수 없어(휴먼 전용 grant 테이블)
    기존 role 게이트만으로도 구조적으로 막혔으나, 명시적 human-only 체크도 독립적으로 403을 낸다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"], is_agent=True)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/epics/{seeded['epic_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_admin_delete_epic_succeeds_and_audit_logged():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, admin_role="admin")
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/epics/{seeded['epic_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
        async with Session() as s:
            from sqlalchemy import select
            from app.models.deletion_audit import DeletionAuditLog
            logs = (await s.execute(
                select(DeletionAuditLog).where(DeletionAuditLog.entity_id == seeded["epic_id"])
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].entity_type == "epic"
            assert logs[0].actor_id == seeded["human_org_member_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_delete_project_forbidden():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_project_only(s)
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"], is_agent=True)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/projects/{seeded['project_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# NOTE(별개 발견·SEC-S1 스코프 밖): human-admin이 실제로 delete_project를 완주하는 realdb 테스트는
# 의도적으로 뺐다 — `ProjectRepository.delete()`가 `session.delete(project)`를 호출할 때
# SQLAlchemy ORM이 `Project.team_members` relationship(cascade 미설정)을 통해 관련
# `team_members`(뷰) 행의 FK를 먼저 NULL로 UPDATE하려다 "cannot update view"로 죽는 사전 존재
# 버그를 이 테스트가 우연히 밟았다(ObjectNotInPrerequisiteStateError) — 실 project_access grant가
# 하나라도 있는 project는 delete_project가 이미 500일 가능성. human-only 게이트 코드 자체(위
# agent 403 테스트로 검증됨)와는 무관한 별개 결함이라 여기서 안 건드리고 스레드에 별도 플래그.


@pytest.mark.anyio
async def test_human_member_role_delete_epic_still_403():
    """member role(admin/owner 아님)인 휴먼도 기존 role 게이트로 403 — human-only 체크 추가가
    기존 role 게이트를 우회시키지 않았음을 확인(회귀 0)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, admin_role="member")
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"], is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/epics/{seeded['epic_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
