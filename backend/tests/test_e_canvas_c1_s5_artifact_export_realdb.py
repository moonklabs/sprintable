"""E-CANVAS C1-S5(story 1f365e33): artifact export(PNG signed-write-URL 3-step, HTML
self-contained) 실증. crux: BE는 바이너리 미경유(FE→GCS 직접 PUT 시뮬레이션 = local provider
직접 put_object) + object_path scope 강제(cross-project export asset 오염 차단) + head_object
phantom 방지."""
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
    """org(project) + artifact(1 version, 1 html_blob node)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.visual_artifact import ArtifactNode, ArtifactVersion, VisualArtifact

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    creator = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="exporter", is_active=True)
    session.add(creator)
    await session.commit()
    creator_id = creator.id
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=creator_id, permission="granted", role="member",
    ))
    await session.commit()

    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Export Artifact",
        source="created", latest_version_number=1, created_by=creator_id,
    )
    session.add(artifact)
    await session.commit()

    version = ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1, created_by=creator_id)
    session.add(version)
    await session.commit()

    node = ArtifactNode(
        id=uuid.uuid4(), artifact_id=artifact.id, version_id=version.id,
        type="html_blob", props={"html": "<h1>Hello</h1>"}, sort_order=0,
    )
    session.add(node)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "artifact_id": artifact.id,
        "version_id": version.id, "creator_id": creator_id,
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


@pytest.mark.anyio
async def test_upload_url_scoped_to_org_project_artifact():
    """upload-url이 반환하는 object_path가 org/project/artifact로 스코프됨(SEC 계열 원칙 계승)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/png/upload-url",
                json={"content_type": "image/png"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()["data"]
            expected_prefix = f"org/{seeded['org_id']}/project/{seeded['project_id']}/artifact/{seeded['artifact_id']}/export/"
            assert body["object_path"].startswith(expected_prefix)
            assert body["upload_url"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_complete_png_export_with_real_uploaded_object():
    """3-step 실증: upload-url → (FE PUT 시뮬레이션: local provider 직접 put_object) → complete
    → asset 등록 + ArtifactExport row + download_url 반환."""
    from app.main import app
    from app.services.storage import get_storage_provider

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            url_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/png/upload-url",
                json={"content_type": "image/png"},
            )
            object_path = url_resp.json()["data"]["object_path"]

            # FE의 signed URL PUT을 로컬 provider put_object로 시뮬레이션(실 GCS 없이도 3-step 실증).
            from app.services.asset_registry import DEFAULT_CONTAINER
            put_ok = await get_storage_provider().put_object(
                DEFAULT_CONTAINER, object_path, b"\x89PNG fake bytes", content_type="image/png",
            )
            assert put_ok

            complete_resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/png/complete",
                json={"object_path": object_path},
            )
            assert complete_resp.status_code == 201, complete_resp.text
            body = complete_resp.json()["data"]
            assert body["format"] == "png"
            assert body["version_number"] == 1
            assert body["asset_id"]
            assert body["download_url"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_complete_png_export_phantom_object_rejected():
    """실 업로드 없이 complete 시도 → 404(head_object 실패=phantom asset 등록 차단)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            phantom_path = (
                f"org/{seeded['org_id']}/project/{seeded['project_id']}/artifact/"
                f"{seeded['artifact_id']}/export/{uuid.uuid4()}.png"
            )
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/png/complete",
                json={"object_path": phantom_path},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_complete_png_export_out_of_scope_path_rejected():
    """crux: object_path가 다른 artifact/project로 스코프되면 403(SEC 계열과 동형 원칙)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            forged_path = f"org/{seeded['org_id']}/project/{seeded['project_id']}/artifact/{uuid.uuid4()}/export/x.png"
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/png/complete",
                json={"object_path": forged_path},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_html_export_self_contained():
    """HTML export — 렌더 불요·즉시 BE 생성+저장(as-authored: html_blob 노드 그대로 삽입)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/html",
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["format"] == "html"
            assert body["download_url"]

            # 실제 저장된 HTML 내용 확認(as-authored html_blob 그대로).
            from app.services.asset_registry import DEFAULT_CONTAINER
            from app.services.storage import get_storage_provider
            from app.models.asset import Asset
            from sqlalchemy import select
            async with Session() as s2:
                asset = (await s2.execute(
                    select(Asset).where(Asset.id == uuid.UUID(body["asset_id"]))
                )).scalar_one()
            html_bytes = await get_storage_provider().download_object(DEFAULT_CONTAINER, asset.object_path)
            assert b"<h1>Hello</h1>" in html_bytes
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_exports_returns_both_formats():
    """GET /exports가 png+html 둘 다 최신순으로 반환."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            await client.post(f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/1/export/html")

            list_resp = await client.get(f"/api/v2/visual-artifacts/{seeded['artifact_id']}/exports")
            assert list_resp.status_code == 200
            items = list_resp.json()["data"]
            assert len(items) == 1
            assert items[0]["format"] == "html"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_export_nonexistent_version_404():
    """존재하지 않는 version_number → 404."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{seeded['artifact_id']}/versions/99/export/html",
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
