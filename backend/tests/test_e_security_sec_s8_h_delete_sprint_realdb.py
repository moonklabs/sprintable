"""E-SECURITY SEC-S8(story 83ea3d6a) H: delete_sprint 휴먼전용화 + 삭제감사 실증.

delete_story/delete_task와 동형 갭 — 인가 검사 자체가 아예 없어(auth dependency도 없었음)
에이전트 API키로도 hard-delete가 가능했고 DeletionAuditLog도 안 남았다. org-scope 자체는
BaseRepository.get()이 org_id로 이미 필터해 안전(cross-org 삭제는 원래도 404)."""
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


async def _seed(session):
    """org(project·sprint) + 휴먼(org member) + 에이전트(project grant)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Sprint
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    sprint = Sprint(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Sprint 1")
    session.add(sprint)
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="agent-x", is_active=True)
    session.add(agent)
    await session.commit()
    agent_id = agent.id
    # resolve_member의 API키 분기는 team_members(뷰=members⋈project_access)에서 찾으므로
    # grant가 있어야 "Team member not found" 400이 아니라 human-gate 403까지 도달한다.
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent_id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "sprint_id": sprint.id,
        "human_user_id": human_user_id, "agent_id": agent_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
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


async def _setup_app_agent(app, Session, agent_id, org_id):
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
            user_id=str(agent_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_agent_cannot_delete_sprint():
    """H 재현: 에이전트 API키로 hard-delete 시도 → 403(기존엔 인가 검사 자체가 없어 200)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/sprints/{seeded['sprint_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_delete_sprint_succeeds_and_audit_logged():
    """회귀 0: 정당한 org 소속 휴먼은 여전히 삭제 가능 + DeletionAuditLog 기록됨."""
    from sqlalchemy import select

    from app.main import app
    from app.models.deletion_audit import DeletionAuditLog

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_human(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/sprints/{seeded['sprint_id']}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["ok"] is True
        finally:
            await client.aclose()

        async with Session() as s:
            logs = (await s.execute(
                select(DeletionAuditLog).where(
                    DeletionAuditLog.entity_id == seeded["sprint_id"],
                    DeletionAuditLog.entity_type == "sprint",
                )
            )).scalars().all()
            assert len(logs) == 1, "삭제 감사 로그가 정확히 1건 기록돼야 함"
            assert logs[0].entity_title == "Sprint 1"
            assert logs[0].org_id == seeded["org_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
