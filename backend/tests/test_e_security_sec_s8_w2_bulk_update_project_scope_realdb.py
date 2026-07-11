"""E-SECURITY SEC-S8(story 83ea3d6a) W2: bulk_update_stories same-org cross-project 미검증
봉쇄 실증 — W(#2039, CRITICAL cross-org)의 후속(project-scope는 별도 PR로 미뤄뒀던 부분).

org_id 필터(W)로 cross-org는 막혔으나, 같은 org 다른 project의(자신은 접근권 없는) story도
bulk PATCH로 여전히 변조할 수 있었다(project-scope 부재, G/T와 동형)."""
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

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A", status="backlog")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B", status="backlog")
    session.add_all([story_a, story_b])
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
        "org_id": org.id, "story_a_id": story_a.id, "story_b_id": story_b.id,
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


@pytest.mark.anyio
async def test_same_org_cross_project_bulk_update_does_not_mutate():
    """W2 재현: project_a에만 grant된 휴먼이 project_b story를 bulk PATCH 시도 → 조용히 스킵(변조 0)."""
    from sqlalchemy import select

    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                "/api/v2/stories/bulk",
                json={"items": [{"id": str(seeded["story_b_id"]), "status": "done", "priority": "critical"}]},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == [], "무권한 project의 story는 결과에 포함되면 안 됨(존재 비노출)"
        finally:
            await client.aclose()

        async with Session() as s:
            victim = (await s.execute(select(Story).where(Story.id == seeded["story_b_id"]))).scalar_one()
            assert victim.status == "backlog", "project-scope 밖 변조가 실제로 반영되면 안 됨"
            assert victim.priority == "medium"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_own_project_bulk_update_still_works():
    """회귀 0: project_a grant 보유 휴먼은 project_a의 story는 여전히 정상 bulk 업데이트."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                "/api/v2/stories/bulk",
                json={"items": [{"id": str(seeded["story_a_id"]), "status": "in-review"}]},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert body[0]["id"] == str(seeded["story_a_id"])
            assert body[0]["status"] == "in-review"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mixed_batch_only_accessible_item_updates():
    """혼합 배치: project_a story는 반영·project_b story는 스킵(부분 성공, 전체차단 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                "/api/v2/stories/bulk",
                json={"items": [
                    {"id": str(seeded["story_a_id"]), "priority": "high"},
                    {"id": str(seeded["story_b_id"]), "priority": "critical"},
                ]},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert body[0]["id"] == str(seeded["story_a_id"])
            assert body[0]["priority"] == "high"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
