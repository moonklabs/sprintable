"""편집 캔버스 핀 저작(story 7fe16274·doc artifact-pin-authoring-spec §2): ArtifactSpecPin 실증.
그라운딩(디디, 재사용 대신 신설): 버전 스코프(carry-forward 필요)·스레드/resolve 없음·명시
anchor_type 판별자가 ArtifactComment와 근본적으로 달라 별도 엔티티로 분리했다. crux: coord/node
앵커 양쪽 수용·description non-null 강제·edit마다 carry-forward(node 삭제 시 pin도 소멸)·
cross-artifact node 위조 차단·과거 버전 pin 불변(최신 버전만 수정/삭제 가능)."""
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
async def test_create_coord_pin_and_list():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Pinned"})
            artifact_id = create_resp.json()["data"]["id"]

            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 10.5, "anchor_y": 20.0, "description": "브랜드 프라이머리"},
            )
            assert pin_resp.status_code == 201, pin_resp.text
            body = pin_resp.json()["data"]
            assert body["anchor_type"] == "coord"
            assert body["anchor_x"] == 10.5 and body["anchor_y"] == 20.0
            assert body["node_id"] is None
            assert body["description"] == "브랜드 프라이머리"
            assert "created_by" not in body and "created_at" not in body  # 감시금지 — attribution 미노출

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            assert list_resp.status_code == 200
            assert len(list_resp.json()["data"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_node_pin_valid_target():
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
                json={"title": "Node Pinned", "nodes": [{"type": "text", "props": {"content": "hello"}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]
            node_id = create_resp.json()["data"]["nodes"][0]["id"]

            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "node", "node_id": node_id, "description": "이 텍스트는 높이 52px"},
            )
            assert pin_resp.status_code == 201, pin_resp.text
            body = pin_resp.json()["data"]
            assert body["anchor_type"] == "node"
            assert body["node_id"] == node_id
            assert body["anchor_x"] is None and body["anchor_y"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_node_pin_cross_artifact_forgery_blocked():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            other_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Other", "nodes": [{"type": "text", "props": {}}]},
            )
            other_node_id = other_resp.json()["data"]["nodes"][0]["id"]

            target_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Target"})
            target_id = target_resp.json()["data"]["id"]

            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{target_id}/pins",
                json={"anchor_type": "node", "node_id": other_node_id, "description": "위조 시도"},
            )
            assert pin_resp.status_code == 404, pin_resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("body", [
    {"anchor_type": "coord", "anchor_x": 10.0, "description": "y 없음"},
    {"anchor_type": "coord", "anchor_x": -1.0, "anchor_y": 5.0, "description": "음수 좌표"},
    {"anchor_type": "coord", "anchor_x": 5.0, "anchor_y": 5.0, "node_id": str(uuid.uuid4()), "description": "coord인데 node_id"},
    {"anchor_type": "node", "description": "node_id 없음"},
    {"anchor_type": "node", "node_id": str(uuid.uuid4()), "anchor_x": 1.0, "description": "node인데 좌표"},
    {"anchor_type": "invalid", "anchor_x": 1.0, "anchor_y": 1.0, "description": "잘못된 타입"},
])
async def test_create_pin_malformed_anchor_422(body):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Malformed"})
            artifact_id = create_resp.json()["data"]["id"]

            resp = await client.post(f"/api/v2/visual-artifacts/{artifact_id}/pins", json=body)
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_pin_empty_description_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Empty Desc"})
            artifact_id = create_resp.json()["data"]["id"]

            resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "   "},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_pin_description():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Editable"})
            artifact_id = create_resp.json()["data"]["id"]
            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "초안"},
            )
            pin_id = pin_resp.json()["data"]["id"]

            update_resp = await client.patch(
                f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}", json={"description": "확定 스펙"},
            )
            assert update_resp.status_code == 200, update_resp.text
            assert update_resp.json()["data"]["description"] == "확定 스펙"

            update_empty_resp = await client.patch(
                f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}", json={"description": ""},
            )
            assert update_empty_resp.status_code == 422
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_pin():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Deletable"})
            artifact_id = create_resp.json()["data"]["id"]
            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "삭제 대상"},
            )
            pin_id = pin_resp.json()["data"]["id"]

            del_resp = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}/pins/{pin_id}")
            assert del_resp.status_code == 200, del_resp.text

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            assert list_resp.json()["data"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_artifact_carries_coord_pin_forward():
    """무-mutate 버전 원칙: 편집(노드 추가)이 기존 coord 핀을 새 버전에 그대로 계승한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Carry"})
            artifact_id = create_resp.json()["data"]["id"]
            await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 42.0, "anchor_y": 7.0, "description": "고정 스펙"},
            )

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )
            assert edit_resp.status_code == 201, edit_resp.text
            assert edit_resp.json()["data"]["version_number"] == 2

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            pins = list_resp.json()["data"]
            assert len(pins) == 1
            assert pins[0]["anchor_x"] == 42.0 and pins[0]["description"] == "고정 스펙"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_artifact_carries_node_pin_forward_with_remapped_id():
    """reflow-safe 실증: node 앵커 핀이 edit 후 id_remap된 새 node_id로 재해석된다(구 node_id
    아님 — ArtifactNode.id는 테이블 전역 PK라 매 버전 새 row)."""
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
                json={"title": "Reflow", "nodes": [{"type": "text", "props": {"content": "keep"}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]
            old_node_id = create_resp.json()["data"]["nodes"][0]["id"]

            await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "node", "node_id": old_node_id, "description": "노드 스펙"},
            )

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "button", "props": {}}]},
            )
            assert edit_resp.status_code == 201, edit_resp.text
            new_nodes = edit_resp.json()["data"]["nodes"]
            new_text_node_id = next(n["id"] for n in new_nodes if n["type"] == "text")
            assert new_text_node_id != old_node_id  # id_remap — 새 PK

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            pins = list_resp.json()["data"]
            assert len(pins) == 1
            assert pins[0]["node_id"] == new_text_node_id
            assert pins[0]["description"] == "노드 스펙"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_edit_artifact_deleting_anchor_node_drops_the_pin():
    """no-fiction: 앵커 노드가 삭제되면 핀은 계승 안 되고 조용히 소멸(죽은 앵커 방치 금지)."""
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
                json={"title": "DropOnDelete", "nodes": [{"type": "text", "props": {}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]
            node_id = create_resp.json()["data"]["nodes"][0]["id"]

            await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "node", "node_id": node_id, "description": "곧 사라질 핀"},
            )

            edit_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "delete", "id": node_id}]},
            )
            assert edit_resp.status_code == 201, edit_resp.text

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            assert list_resp.json()["data"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_previous_version_pin_immutable_and_not_editable():
    """무-mutate: 구버전 핀 row는 그대로 남되(과거 스냅샷), 최신 버전 스코프 밖이라 update/delete
    대상은 아니다(404) — canvas_bounds/node와 동일한 버전 스냅샷 원칙."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/visual-artifacts", json={"title": "Snapshot"})
            artifact_id = create_resp.json()["data"]["id"]
            pin_resp = await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/pins",
                json={"anchor_type": "coord", "anchor_x": 1.0, "anchor_y": 1.0, "description": "v1 핀"},
            )
            old_pin_id = pin_resp.json()["data"]["id"]

            await client.post(
                f"/api/v2/visual-artifacts/{artifact_id}/edit",
                json={"operations": [{"op": "add", "type": "text", "props": {}}]},
            )

            # 구버전 pin_id(v1의 row)로 update 시도 — 최신 버전(v2)엔 다른 새 id의 계승 row가 있음.
            update_resp = await client.patch(
                f"/api/v2/visual-artifacts/{artifact_id}/pins/{old_pin_id}", json={"description": "수정 시도"},
            )
            assert update_resp.status_code == 404, update_resp.text

            list_resp = await client.get(f"/api/v2/visual-artifacts/{artifact_id}/pins")
            pins = list_resp.json()["data"]
            assert len(pins) == 1
            assert pins[0]["id"] != old_pin_id
            assert pins[0]["description"] == "v1 핀"  # 계승된 내용은 동일
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mcp_create_and_list_spec_pin_roundtrip():
    """AC4 동형: MCP sprintable_create_spec_pin → sprintable_list_spec_pins 왕복."""
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
            CreateArtifactInput, CreateSpecPinInput, ListSpecPinsInput,
            create_artifact, create_spec_pin, list_spec_pins,
        )

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
            created = json.loads((await create_artifact(CreateArtifactInput(title="MCP Pinned")))[0].text)

            pin_created = json.loads((await create_spec_pin(CreateSpecPinInput(
                artifact_id=created["id"], anchor_type="coord", anchor_x=3.0, anchor_y=4.0,
                description="MCP 저작 스펙",
            )))[0].text)
            assert pin_created["description"] == "MCP 저작 스펙"

            pins = json.loads((await list_spec_pins(ListSpecPinsInput(artifact_id=created["id"])))[0].text)
            assert len(pins) == 1
            assert pins[0]["id"] == pin_created["id"]
        finally:
            real_client.post, real_client.get = orig_post, orig_get
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
