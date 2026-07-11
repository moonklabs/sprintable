"""E-SECURITY SEC-S8(story 83ea3d6a) S: create_task project-scope 미검증 봉쇄 실증.

create_task가 GET/PATCH/DELETE와 달리 `_assert_task_project_access`를 호출하지 않아
org-scope만(enforce_body_context는 body_project_id 미전달이라 project 검증 스킵) — 같은 org
다른 project의(자신은 접근권 없는) member가 임의 story_id로 task를 생성할 수 있었다
(까심 실HTTP 확定: Project A caller가 Project B story_id로 201)."""
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
    """org(project_a, project_b) + story_a(project_a)/story_b(project_b) +
    human_a(project_a에만 명시 grant, project_b 접근권 없음)."""
    from app.models.organization import Organization
    from app.models.pm import Story
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

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B")
    session.add_all([story_a, story_b])
    await session.commit()

    human_user_id = uuid.uuid4()
    human_user = User(id=human_user_id, email=f"human-{human_user_id.hex[:8]}@test.com", hashed_password="x")
    session.add(human_user)
    await session.commit()
    human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_user_id, role="member")
    session.add(human_om)
    await session.commit()
    # project_a에만 명시 grant — project_b 접근권 없음(org owner/admin도 아님).
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=human_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "story_a_id": story_a.id, "story_b_id": story_b.id, "human_user_id": human_user_id,
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


@pytest.mark.anyio
async def test_no_grant_human_cannot_create_task_on_other_project_story():
    """S 재현: project_a에만 grant된 휴먼이 project_b의 story_id로 task 생성 시도 → 403
    (기존엔 org-scope만 봐서 201로 통과했음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/tasks",
                json={
                    "story_id": str(seeded["story_b_id"]), "org_id": str(seeded["org_id"]),
                    "title": "Injected Task",
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_project_a_human_can_still_create_task_on_own_project_story():
    """회귀 0: project_a grant 보유 휴먼은 project_a의 story_id로 task 생성 여전히 정상."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/tasks",
                json={
                    "story_id": str(seeded["story_a_id"]), "org_id": str(seeded["org_id"]),
                    "title": "Legit Task",
                },
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["story_id"] == str(seeded["story_a_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
