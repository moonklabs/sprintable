"""[SEC][HIGH] story b4027b2e(까심 #2140 QA④ 적출) — 실 PG.

`/api/v2/visual-artifacts` write 라우트가 `_PATH_GROUP_PREFIXES` 미등록(permissive-unmapped
폴백) **+ 라우터 자체가 `get_verified_org_id`(scope 체크 트리거)를 안 씀** 이중 갭으로, toolgroup
제한(예 scope=['docs']) API 키가 mutation을 무제한 통과했다(까심 라이브 실증: docs키 POST→201,
d764522c와 동형 계보). 이번 수정: `visual_artifacts.py`의 write 12라우트(원 9 + rebase 후 합류한
핀 3종)에 `get_verified_org_id` 의존성 배선 + `_PATH_GROUP_PREFIXES`에 "canvas" 그룹 등록 + MCP
쪽도 `_ALWAYS_ALLOWED`에서 "canvas" 그룹으로 재분류(양쪽 정합).

각 라우트: toolgroup-scope(scope=['docs'], canvas 없음)=403 · canvas-scope(scope=['canvas'])=
성공(over-block 방지) · 레거시(scope=['read','write'])=성공(무회귀) · JWT(human)=성공(무회귀,
기존 스위트가 이미 커버하지만 이 파일에서도 1건 명시)."""
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


async def _setup_app_api_key(app, Session, org_id, project_id, *, scope: list[str]):
    """API-key AuthContext — api_key_id 마커가 있어야 _check_api_key_scope가 게이트를 적용."""
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
            user_id=str(uuid.uuid4()), email=None,
            claims={"app_metadata": {
                "org_id": str(org_id), "project_id": str(project_id),
                "api_key_id": str(uuid.uuid4()), "scope": scope,
            }},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _setup_app_jwt(app, Session, org_id, project_id):
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
            user_id=str(uuid.uuid4()), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


# ── create_artifact(POST) ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_artifact_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Sabotage"})
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_canvas_scope_201_no_overblock():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["canvas"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Legit", "nodes": [{"type": "text", "props": {}}]})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_legacy_write_scope_201_no_regression():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["read", "write"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Legacy", "nodes": [{"type": "text", "props": {}}]})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_artifact_jwt_human_201_no_regression():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Human", "nodes": [{"type": "text", "props": {}}]})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── edit_artifact(POST) ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_edit_artifact_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_artifact_canvas_scope_201_no_overblock():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["canvas"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── delete_artifact(DELETE) ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_artifact_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── add_artifact_comment(POST) ──────────────────────────────────────────────

@pytest.mark.anyio
async def test_add_comment_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/comments", json={"content": "sabotage"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── propose_canonical_version(POST) ─────────────────────────────────────────

@pytest.mark.anyio
async def test_propose_canonical_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/visual-artifacts/{artifact_id}/versions/1/canonicalize")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── read 라우트는 여전히 미가드(scope 무관 200) — 회귀축 명시(read는 이 스토리 스코프 밖) ──

@pytest.mark.anyio
async def test_get_artifact_read_route_unaffected_by_scope():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Readable", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── spec pin write 라우트(story 7fe16274·rebase 후 합류) — 동일 gap 대상 ────────

@pytest.mark.anyio
async def test_create_spec_pin_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "sabotage"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_spec_pin_canvas_scope_201_no_overblock():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["canvas"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "legit"},
            )
            assert resp.status_code == 201, resp.text
            pin_id = resp.json()["data"]["id"]
        finally:
            await client.aclose()

        # update/delete도 동일 canvas-scope로 성공(over-block 방지).
        client = _client_for(app)
        try:
            upd = await client.patch(
                f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}", json={"description": "edited"},
            )
            assert upd.status_code == 200, upd.text
            deleted = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}")
            assert deleted.status_code == 200, deleted.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_delete_spec_pin_toolgroup_scope_without_canvas_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_jwt(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target", "nodes": [{"type": "text", "props": {}}]})
            artifact_id = create_resp.json()["data"]["id"]
            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "existing"},
            )
            pin_id = pin_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app_api_key(app, Session, seeded["org_id"], seeded["project_id"], scope=["docs"])
        client = _client_for(app)
        try:
            upd = await client.patch(
                f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}", json={"description": "sabotage"},
            )
            assert upd.status_code == 403, upd.text
            deleted = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}")
            assert deleted.status_code == 403, deleted.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
