"""뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4): canvas_bounds 실증.
crux: 버전 단위 SSOT(artifact.canvas_bounds는 denorm 캐시)·미선언 시 직전 버전 값 carry-forward·
operations 없이 canvas_bounds만으로도 새 버전 생성(무-mutate 버전 원칙 계승)·양수/상한 검증."""
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
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id}


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
async def test_create_with_canvas_bounds_declared():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Framed", "canvas_bounds": {"w": 1200, "h": 800}, "nodes": [{"type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert body["canvas_bounds"] == {"w": 1200, "h": 800}
            artifact_id = body["id"]

            # list_artifacts summary도 denorm 캐시로 동일 값 노출.
            list_resp = await client.get("/api/v2/visual-artifacts")
            item = next(i for i in list_resp.json()["data"] if i["id"] == artifact_id)
            assert item["canvas_bounds"] == {"w": 1200, "h": 800}

            # versions summary도 동일 값(실 컬럼 from_attributes).
            versions_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/versions")
            assert versions_resp.json()["data"][0]["canvas_bounds"] == {"w": 1200, "h": 800}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_without_canvas_bounds_is_null():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Unframed", "nodes": [{"type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
            assert resp.json()["data"]["canvas_bounds"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_without_canvas_bounds_carries_forward():
    """미지정 시 직전 버전 값을 그대로 이어받는다 — operations 편집이 프레임을 지우면 안 됨."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Carry", "canvas_bounds": {"w": 640, "h": 480}, "nodes": [{"type": "text", "props": {}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert edit_resp.status_code == 201, edit_resp.text
            body = edit_resp.json()["data"]
            assert body["version_number"] == 2
            assert body["canvas_bounds"] == {"w": 640, "h": 480}

            # artifact denorm 캐시도 최신 버전 값과 동기화돼야 함.
            get_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}")
            assert get_resp.json()["data"]["canvas_bounds"] == {"w": 640, "h": 480}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_with_explicit_canvas_bounds_redeclares_and_bumps_version():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Redeclare", "canvas_bounds": {"w": 640, "h": 480}, "nodes": [{"type": "text", "props": {}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={
                    "operations": [{"op": "add", "type": "text", "props": {}}],
                    "canvas_bounds": {"w": 1920, "h": 1080},
                },
            )
            assert edit_resp.status_code == 201, edit_resp.text
            body = edit_resp.json()["data"]
            assert body["version_number"] == 2
            assert body["canvas_bounds"] == {"w": 1920, "h": 1080}

            # v1 스냅샷은 자기 선언 값 그대로 — 무-mutate 원칙.
            v1_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/versions/1")
            assert v1_resp.json()["data"]["canvas_bounds"] == {"w": 640, "h": 480}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_with_only_canvas_bounds_no_operations_creates_new_version():
    """무-mutate 버전 원칙: 프레임만 바뀌어도 새 버전이 생기고, 기존 노드는 그대로 계승."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={
                    "title": "Bounds Only", "canvas_bounds": {"w": 640, "h": 480},
                    "nodes": [{"type": "text", "props": {"content": "hello"}}],
                },
            )
            artifact_id = create_resp.json()["data"]["id"]

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"canvas_bounds": {"w": 800, "h": 600}},
            )
            assert edit_resp.status_code == 201, edit_resp.text
            body = edit_resp.json()["data"]
            assert body["version_number"] == 2
            assert body["canvas_bounds"] == {"w": 800, "h": 600}
            assert len(body["nodes"]) == 1
            assert body["nodes"][0]["props"]["content"] == "hello"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_with_no_operations_and_no_canvas_bounds_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Empty Edit", "nodes": [{"type": "text", "props": {}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]

            resp = await client.post(f"/api/v2/visual-artifacts/{artifact_id}/edit", json={})
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("bounds", [
    {"w": 0, "h": 100},
    {"w": 100, "h": -5},
    {"w": 20001, "h": 100},
    {"w": 100, "h": 20001},
])
async def test_create_with_malformed_canvas_bounds_422(bounds):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts", json={"title": "Bad Bounds", "canvas_bounds": bounds},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_with_missing_h_field_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts", json={"title": "Partial Bounds", "canvas_bounds": {"w": 100}},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mcp_create_and_edit_canvas_bounds_roundtrip():
    """AC4 동형: MCP sprintable_create_artifact(canvas_bounds) → sprintable_edit_artifact
    (canvas_bounds만 재선언) 왕복."""
    import json
    import os as _os

    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])

        _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        _os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp import api_client as api_client_mod
        from sprintable_mcp.tools.visual_artifacts import (
            ArtifactNodeInput, CanvasBoundsInput, CreateArtifactInput, EditArtifactInput,
            create_artifact, edit_artifact,
        )

        transport = httpx.ASGITransport(app=app)
        real_client = api_client_mod.client
        test_http_client = httpx.AsyncClient(transport=transport, base_url="http://test")

        async def _post(path, **kwargs):
            r = await test_http_client.post(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        orig_post = real_client.post
        real_client.post = _post
        try:
            created = json.loads((await create_artifact(CreateArtifactInput(
                title="MCP Framed", canvas_bounds=CanvasBoundsInput(w=1024, h=768),
                nodes=[ArtifactNodeInput(type="text")],
            )))[0].text)
            assert created["canvas_bounds"] == {"w": 1024, "h": 768}

            edited = json.loads((await edit_artifact(EditArtifactInput(
                artifact_id=created["id"], canvas_bounds=CanvasBoundsInput(w=2048, h=1536),
            )))[0].text)
            assert edited["version_number"] == 2
            assert edited["canvas_bounds"] == {"w": 2048, "h": 1536}
        finally:
            real_client.post = orig_post
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
