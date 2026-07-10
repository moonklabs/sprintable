"""E-CANVAS C1-S3(story 8bace49e): visual_artifact + artifact_version + artifact_node —
모델·API·MCP 실증. crux: cross-org 연결 대상 차단(assert_target_in_caller_org 재사용)·
html_blob 하이브리드 노드·버전 전환 무-mutate·MCP create→get 왕복."""
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
        "org_a_id": org_a.id, "org_b_id": org_b.id,
        "project_a_id": project_a.id, "story_a_id": story_a.id, "story_b_id": story_b.id,
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
async def test_create_artifact_cross_org_story_link_blocked():
    """crux①: Org A caller가 Org B story_id로 연결 시도 → 404."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
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
async def test_create_artifact_with_html_blob_node_and_get_roundtrip():
    """crux②③: html_blob 캐치올 노드 생성 + 조회 왕복(source=imported)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/visual-artifacts",
                json={
                    "title": "Imported Page", "story_id": str(seeded["story_a_id"]),
                    "source": "imported", "summary": "초기 임포트",
                    "nodes": [{"type": "html_blob", "props": {"html": "<div>hi</div>"}, "sort_order": 0}],
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            artifact_id = body["id"]
            assert body["source"] == "imported"
            assert body["anchor_version"] is None
            assert body["version_summary"] == "초기 임포트"
            assert len(body["nodes"]) == 1
            assert body["nodes"][0]["type"] == "html_blob"
            assert body["nodes"][0]["props"]["html"] == "<div>hi</div>"

            get_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}")
            assert get_resp.status_code == 200, get_resp.text
            get_body = get_resp.json()["data"]
            assert get_body["nodes"][0]["type"] == "html_blob"
            assert get_body["story_id"] == str(seeded["story_a_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_version_switch_is_read_only_no_mutation():
    """crux④: 버전 조회가 무-mutate — GET /versions/{n} 반복 호출해도 동일 결과(mockup의
    restore=즉시 라이브 덮어씀과 대조되는 신설 조합)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "V1", "nodes": [{"type": "text", "props": {"content": "hello"}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]

            v1a = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/versions/1")
            v1b = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/versions/1")
            assert v1a.status_code == 200 and v1b.status_code == 200
            assert v1a.json()["data"]["nodes"] == v1b.json()["data"]["nodes"]

            versions_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/versions")
            assert versions_resp.status_code == 200
            assert len(versions_resp.json()["data"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_artifacts_by_story_id():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])
        client = _client_for(app)
        try:
            await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Attached", "story_id": str(seeded["story_a_id"])},
            )
            await client.post("/api/v2/visual-artifacts", json={"title": "Unattached"})

            resp = await client.get(f"/api/v2/visual-artifacts?story_id={seeded['story_a_id']}")
            assert resp.status_code == 200
            items = resp.json()["data"]
            assert len(items) == 1
            assert items[0]["title"] == "Attached"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_artifact_creator_only():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        creator_id = uuid.uuid4()
        other_id = uuid.uuid4()

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"], user_id=creator_id)
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Mine"})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 다른 사용자 시도 → 403
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"], user_id=other_id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        # 생성자 본인 → 200
        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"], user_id=creator_id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mcp_create_and_get_roundtrip():
    """AC4 실증: MCP sprintable_create_artifact → sprintable_get_artifact 왕복."""
    import os as _os
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_a_id"], seeded["project_a_id"])

        _os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        _os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp.tools.visual_artifacts import (
            ArtifactNodeInput, CreateArtifactInput, GetArtifactInput, create_artifact, get_artifact,
        )
        from sprintable_mcp import api_client as api_client_mod

        transport = httpx.ASGITransport(app=app)
        real_client = api_client_mod.client
        test_http_client = httpx.AsyncClient(transport=transport, base_url="http://test")

        async def _post(path, **kwargs):
            r = await test_http_client.post(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        async def _get(path, **kwargs):
            r = await test_http_client.get(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        orig_post, orig_get = real_client.post, real_client.get
        real_client.post = _post
        real_client.get = _get
        try:
            create_result = await create_artifact(CreateArtifactInput(
                title="MCP Artifact",
                nodes=[ArtifactNodeInput(type="text", props={"content": "hi"})],
            ))
            import json
            created = json.loads(create_result[0].text)
            artifact_id = created["id"]

            get_result = await get_artifact(GetArtifactInput(artifact_id=artifact_id))
            fetched = json.loads(get_result[0].text)
            assert fetched["id"] == artifact_id
            assert fetched["title"] == "MCP Artifact"
            assert fetched["nodes"][0]["type"] == "text"
        finally:
            real_client.post, real_client.get = orig_post, orig_get
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
