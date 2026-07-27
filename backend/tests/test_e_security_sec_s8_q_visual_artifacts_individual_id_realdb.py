"""E-SECURITY SEC-S8(story 83ea3d6a) Q: visual_artifacts 개별-ID GET/versions/version-detail/
DELETE의 project-scope 미검증 봉쇄 실증.

`_get_artifact_or_404`가 org_id만 필터하고 project_id는 비교하지 않아, 같은 org 내 다른
project의 artifact를 개별-ID로 직접 조회/삭제하면 G(N)의 list project_id 필터를 그대로
우회했다(까심 QA: project_b artifact를 project_a 컨텍스트에서 /versions로 200 실측)."""
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
    """org(project_a, project_b) + artifact_a(project_a) + artifact_b(project_b, 1개 version)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    creator_id = uuid.uuid4()
    artifact_b = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project_b.id, title="Artifact B",
        source="created", latest_version_number=1, created_by=creator_id,
    )
    session.add(artifact_b)
    await session.commit()
    version_b = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact_b.id, version_number=1, created_by=creator_id)
    session.add(version_b)
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "artifact_b_id": artifact_b.id, "creator_id": creator_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id, project_id):
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
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_get_artifact_cross_project_blocked():
    """Q 재현: project_a 컨텍스트 caller가 project_b의 artifact id로 GET → 404(기존엔 200)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, uuid.uuid4(), seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_b_id']}")
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_artifact_versions_cross_project_blocked():
    """Q 재현: /versions도 cross-project artifact id로는 NOT_FOUND(기존엔 실 버전 목록 200)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, uuid.uuid4(), seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_b_id']}/versions")
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_artifact_version_cross_project_blocked():
    """Q 재현: version-detail도 cross-project artifact id로는 NOT_FOUND."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, uuid.uuid4(), seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_b_id']}/versions/1")
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_artifact_cross_project_blocked():
    """Q 재현: DELETE도 cross-project artifact id로는 NOT_FOUND(생성자 체크에 도달 못 함)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        # 생성자 본인이어도 다른 project 컨텍스트면 차단(project 우회가 근본 갭이므로).
        await _setup_app(app, Session, seeded["creator_id"], seeded["org_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/visual-artifacts/{seeded['artifact_b_id']}")
            assert resp.status_code == 404
            assert resp.json()["error"]["code"] == "NOT_FOUND"
        finally:
            await client.aclose()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.visual_artifact import VisualArtifact
            artifact = (await s.execute(
                select(VisualArtifact).where(VisualArtifact.id == seeded["artifact_b_id"])
            )).scalar_one_or_none()
            assert artifact is not None and artifact.deleted_at is None, "cross-project 우회로 삭제되면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_artifact_same_project_succeeds():
    """회귀 0: 정당한 project_b 컨텍스트 caller는 여전히 artifact_b를 정상 조회."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, uuid.uuid4(), seeded["org_id"], seeded["project_b_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_b_id']}")
            assert resp.status_code == 200
            assert resp.json()["data"]["id"] == str(seeded["artifact_b_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
