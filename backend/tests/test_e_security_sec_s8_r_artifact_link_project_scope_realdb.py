"""E-SECURITY SEC-S8(story 83ea3d6a) R: create_artifact story_id/epic_id/doc_id 링크의
project-scope 미검증 봉쇄 실증.

`_assert_link_target_in_org`(구)가 target의 org_id만 대조하고 project_id는 안 봐서, 같은 org
내 다른 project의 story/epic/doc에 artifact를 링크할 수 있었다(G/Q와 동형 project-scope
부재). fix=`_assert_link_target_in_scope`가 target project_id도 caller project_id와 대조."""
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
    """org(project_a, project_b) + story_a(project_a)/epic_a(project_a)/doc_a(project_a) +
    story_b/epic_b/doc_b(project_b, 같은 org) — same-org cross-project 링크 시도용."""
    from app.models.doc import Doc
    from app.models.organization import Organization
    from app.models.pm import Epic, Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    story_a = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Story A", status="backlog")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Story B", status="backlog")
    epic_a = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Epic A")
    epic_b = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Epic B")
    doc_a = Doc(
        id=uuid.uuid4(), org_id=org.id, project_id=project_a.id, title="Doc A",
        slug=f"doc-a-{uuid.uuid4().hex[:8]}", content="",
    )
    doc_b = Doc(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Doc B",
        slug=f"doc-b-{uuid.uuid4().hex[:8]}", content="",
    )
    session.add_all([story_a, story_b, epic_a, epic_b, doc_a, doc_b])
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "story_a_id": story_a.id, "story_b_id": story_b.id,
        "epic_a_id": epic_a.id, "epic_b_id": epic_b.id,
        "doc_a_id": doc_a.id, "doc_b_id": doc_b.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id):
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
            user_id=str(uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_create_artifact_same_org_cross_project_story_link_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Injected", "story_id": str(seeded["story_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_same_org_cross_project_epic_link_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Injected", "epic_id": str(seeded["epic_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_same_org_cross_project_doc_link_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Injected", "doc_id": str(seeded["doc_b_id"])},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_same_project_story_link_still_works():
    """회귀: same-org same-project 링크는 여전히 정상(과차단 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Legit", "story_id": str(seeded["story_a_id"])},
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["data"]["story_id"] == str(seeded["story_a_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
