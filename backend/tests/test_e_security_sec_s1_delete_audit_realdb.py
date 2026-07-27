"""E-SECURITY SEC-S1(story 70c9e92c): hard-delete 휴먼 전용화 + 삭제 감사 — 실 Postgres 검증."""
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


async def _seed(session, *, human_id: uuid.UUID | None = None):
    """org + project + agent + (선택) human org_member + story."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story
    from app.models.user import User
    from app.models.project import OrgMember

    org = Organization(id=uuid.uuid4(), name="SEC-S1 Org", slug=f"sec-s1-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="SEC-S1 Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Deleting Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="To Be Deleted", status="backlog")
    session.add(story)
    await session.commit()

    human_user_id = None
    human_org_member_id = None
    if human_id is not None:
        user = User(id=human_id, email=f"human-{human_id}@test.com", hashed_password="x")
        session.add(user)
        await session.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_id, role="member")
        session.add(om)
        await session.commit()
        # E-SECURITY SEC-S3(story 90cd7e57) develop merge 정합: delete_story가 human-gate
        # (SEC-S1) 외에 has_project_access(SEC-S3)도 요구하게 됐으므로, 삭제 성공을 검증하는
        # 시나리오는 project grant가 필요하다(존재하지 않는 story 404 테스트는 이 체크에
        # 도달하기 전에 404가 나므로 grant 유무와 무관).
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted",
        ))
        await session.commit()
        human_user_id = human_id
        human_org_member_id = om.id

    return org.id, project.id, agent.id, story.id, human_user_id, human_org_member_id


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
async def test_agent_delete_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, _hu, _ho = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id, is_agent=True)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{story_id}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        # story는 그대로 존재
        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Story
            story = (await s.execute(select(Story).where(Story.id == story_id))).scalar_one_or_none()
            assert story is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_delete_succeeds_and_audit_logged():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        human_id = uuid.uuid4()
        async with Session() as s:
            org_id, project_id, agent_id, story_id, human_user_id, human_org_member_id = await _seed(s, human_id=human_id)

        await _setup_app(app, Session, human_id, org_id, is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{story_id}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.pm import Story
            from app.models.deletion_audit import DeletionAuditLog

            story = (await s.execute(select(Story).where(Story.id == story_id))).scalar_one_or_none()
            assert story is None  # 실제로 삭제됨

            logs = (await s.execute(
                select(DeletionAuditLog).where(DeletionAuditLog.entity_id == story_id)
            )).scalars().all()
            assert len(logs) == 1
            log = logs[0]
            assert log.entity_type == "story"
            assert log.org_id == org_id
            assert log.entity_title == "To Be Deleted"
            # actor_id는 resolve_member 결과(휴먼=org_member.id) — human_org_member_id와 일치
            assert log.actor_id == human_org_member_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_story_not_found_still_404():
    """회귀: 존재하지 않는 story는 여전히 404(auth 체크가 그걸 가리면 안 됨)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        human_id = uuid.uuid4()
        async with Session() as s:
            org_id, project_id, agent_id, story_id, human_user_id, human_org_member_id = await _seed(s, human_id=human_id)

        await _setup_app(app, Session, human_id, org_id, is_agent=False)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/stories/{uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
