"""story b6b9c52d(#2707 부수) — MCP `sprintable_import_image_artifact` 전용 원콜 이미지 임포트
BE 엔드포인트(`POST /api/v2/visual-artifacts/import-image`). crux: content-type/size 검증·
base64 디코드 실패 처리·업로드→create_artifact 위임 왕복(source=imported·html_blob 노드·
canonical url)·story_id cross-org 스코프 차단(create_artifact의 _assert_link_target_in_scope
재사용 확인, C1-S3 crux①과 동형)."""
from __future__ import annotations

import base64
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
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.pm import Story

    org_a = Organization(id=uuid.uuid4(), name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(id=uuid.uuid4(), name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    session.add_all([org_a, org_b])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org_a.id, name="Org A Project")
    project_b = Project(id=uuid.uuid4(), org_id=org_b.id, name="Org B Project")
    session.add_all([project_a, project_b])
    await session.commit()

    story_a = Story(id=uuid.uuid4(), org_id=org_a.id, project_id=project_a.id, title="Story A", status="backlog")
    story_b = Story(id=uuid.uuid4(), org_id=org_b.id, project_id=project_b.id, title="Story B", status="backlog")
    session.add_all([story_a, story_b])
    await session.commit()

    return {
        "org_a_id": org_a.id, "project_a_id": project_a.id,
        "story_a_id": story_a.id, "story_b_id": story_b.id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, project_id, user_id=None):
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
            user_id=str(user_id or uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _post_import(client, **body):
    return await client.post("/api/v2/visual-artifacts/import-image", json=body)


@pytest.mark.anyio
async def test_import_image_rejects_non_image_content_type():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await _post_import(
                client, title="Sketch",
                image_base64=base64.b64encode(b"fake-bytes").decode(),
                content_type="text/plain",
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_rejects_invalid_base64():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await _post_import(
                client, title="Sketch", image_base64="not-valid-base64-!!!", content_type="image/png",
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_rejects_oversized_payload():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            oversized = os.urandom(20 * 1024 * 1024 + 1)
            resp = await _post_import(
                client, title="Sketch",
                image_base64=base64.b64encode(oversized).decode(), content_type="image/png",
            )
            assert resp.status_code == 413, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_success_creates_artifact_with_canonical_url():
    """crux②③⑤: 업로드→create_artifact 위임 왕복 — source=imported·html_blob 노드·
    props.src가 canonical GCS url 형태(서명 쿼리 없음, artifact_image_url.py 컨벤션과 동형)."""
    from app.main import app
    from app.services.asset_registry import DEFAULT_CONTAINER

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            image_bytes = os.urandom(1024)
            resp = await _post_import(
                client, title="Sketch v1",
                image_base64=base64.b64encode(image_bytes).decode(), content_type="image/png",
                story_id=str(seeded["story_a_id"]),
            )
            assert resp.status_code == 201, resp.text
            data = resp.json()["data"]
            assert data["source"] == "imported"
            assert data["story_id"] == str(seeded["story_a_id"])
            assert len(data["nodes"]) == 1
            node = data["nodes"][0]
            assert node["type"] == "html_blob"
            # 응답의 props.src는 항상 신선 서명본(story #2711 AC1 — read 경로가 raw를 그대로
            # 주지 않는다) — canonical raw 저장을 검증하려면 DB를 직접 봐야 한다(아래).
            assert "canvas-import/" in node["props"]["src"]

            from app.models.visual_artifact import ArtifactNode
            from sqlalchemy import select
            async with Session() as verify_session:
                stored_node = (await verify_session.execute(
                    select(ArtifactNode).where(ArtifactNode.artifact_id == uuid.UUID(data["id"]))
                )).scalar_one()
            stored_src = stored_node.props["src"]
            assert stored_src.startswith(
                f"https://storage.googleapis.com/{DEFAULT_CONTAINER}/org/{seeded['org_a_id']}/"
                f"project/{seeded['project_a_id']}/canvas-import/"
            )
            assert "?" not in stored_src  # raw canonical — 서명 쿼리스트링 없음(write 경로 canonicalize)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_import_image_cross_org_story_link_blocked():
    """crux①: Org A caller가 Org B story_id로 연결 시도 → 404(create_artifact의
    _assert_link_target_in_scope 위임 재사용 확인 — C1-S3 crux①과 동형 축)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await _post_import(
                client, title="Injected",
                image_base64=base64.b64encode(os.urandom(16)).decode(), content_type="image/png",
                story_id=str(seeded["story_b_id"]),
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
