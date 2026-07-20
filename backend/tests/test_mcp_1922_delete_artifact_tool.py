"""story #1922: sprintable_delete_artifact MCP 도구 테스트.

DELETE /api/v2/visual-artifacts/{id}(생성자 전용 soft delete)의 얇은 래퍼 — delete_spec_pin과
동형 최소 구현(backend/sprintable_mcp/tools/visual_artifacts.py). SEC-S1이 차단한
delete_story/delete_task/delete_epic/delete_doc류(hard-delete cascade)와 다른 리스크 클래스:
deleted_at 타임스탬프 플립일 뿐 자식 row 물리삭제 없음 — 그래서 MCP 표면에 유지된다.

핵심 AC: 403("생성자만 삭제할 수 있습니다")이 라우터의 로컬 _err() 엔벨로프
({"error": {"code","message"}})를 거쳐 api_client._extract_error_message()에서
가독 텍스트로 나와야 한다(불투명 실패 금지) — mock 만이 아니라 그 엔벨로프 shape 자체를
직접 검증한다(아래 test_error_envelope_shape_matches_router_err_helper).
"""
from __future__ import annotations

import json
import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sprintable_mcp.api_client import SprintableApiError, _extract_error_message
from sprintable_mcp.tools import visual_artifacts as va


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(**methods):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    for name, ret in methods.items():
        setattr(c, name, AsyncMock(return_value=ret))
    return c


def _error_client(exc: Exception):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    c.delete = AsyncMock(side_effect=exc)
    return c


# ── 0. 라우터 _err() 엔벨로프 shape가 _extract_error_message()에서 가독 텍스트로 뽑히는지 ──
# (backend/app/routers/visual_artifacts.py:46 _err()가 만드는 정확한 shape로 직접 검증)

def test_error_envelope_shape_matches_router_err_helper():
    """router._err("FORBIDDEN", "생성자만 삭제할 수 있습니다", 403)이 JSONResponse로 만드는
    본문 {"data": None, "error": {"code": "FORBIDDEN", "message": "..."}, "meta": None}을
    httpx가 그대로 resp.json()해 api_client._extract_error_message에 넘긴 경우를 재현 —
    표준 {error:{code,message}} 엔벨로프(shape 1)와 정확히 일치해 가독 메시지가 나와야 한다."""
    body = {"data": None, "error": {"code": "FORBIDDEN", "message": "생성자만 삭제할 수 있습니다"}, "meta": None}
    msg = _extract_error_message(403, body)
    assert msg == "FORBIDDEN: 생성자만 삭제할 수 있습니다"

    body_404 = {"data": None, "error": {"code": "NOT_FOUND", "message": "Artifact not found"}, "meta": None}
    assert _extract_error_message(404, body_404) == "NOT_FOUND: Artifact not found"


# ── 1. 생성자 본인 삭제 성공 ────────────────────────────────────────────────────

async def test_creator_deletes_own_artifact_success():
    client = _client(delete={"ok": True, "id": "a1"})
    args = va.DeleteArtifactInput(artifact_id="a1")
    with patch.object(va, "client", client):
        out = await va.delete_artifact(args)
    assert client.delete.call_args.args[0] == "/api/v2/visual-artifacts/a1"
    data = json.loads(out[0].text)
    assert data == {"ok": True, "id": "a1"}


# ── 2. 비-생성자 403 — 가독 메시지(불투명 "an error occurred" 아님) ──────────────

async def test_non_creator_gets_readable_403():
    client = _error_client(SprintableApiError(403, "FORBIDDEN: 생성자만 삭제할 수 있습니다"))
    args = va.DeleteArtifactInput(artifact_id="a1")
    with patch.object(va, "client", client):
        out = await va.delete_artifact(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "생성자만 삭제할 수 있습니다" in text
    assert "FORBIDDEN" in text
    # 불투명 실패가 아님을 명시적으로 반증 — "an error occurred" 류의 무의미 텍스트가 아니다.
    assert text != "Error: an error occurred"


# ── 3. 존재하지 않는 artifact — 가독 404 ────────────────────────────────────────

async def test_nonexistent_artifact_readable_404():
    client = _error_client(SprintableApiError(404, "NOT_FOUND: Artifact not found"))
    args = va.DeleteArtifactInput(artifact_id="does-not-exist")
    with patch.object(va, "client", client):
        out = await va.delete_artifact(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "NOT_FOUND" in text
    assert "Artifact not found" in text


# ═══════════════════════════════════════════════════════════════════════════
# realdb: create → delete → list/get-excludes 왕복(라우터의 deleted_at 필터링 실증)
# ═══════════════════════════════════════════════════════════════════════════

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark_realdb = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


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


@pytestmark_realdb
@pytest.mark.anyio
async def test_realdb_creator_only_403_readable_via_http():
    """라이브 HTTP 왕복: 비-생성자 DELETE → 403 + 라우터 _err() 본문이 그대로 나오는지(router-level,
    creator-only 게이트 자체는 test_e_canvas_c1_s3_visual_artifact_realdb.py에 이미 커버 —
    여기선 message 가독성 초점)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        creator_id = uuid.uuid4()
        other_id = uuid.uuid4()

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=creator_id)
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/visual-artifacts",
                json={"title": "Mine", "nodes": [{"type": "text", "props": {}}]},
            )
            artifact_id = create_resp.json()["data"]["id"]
        finally:
            await client.aclose()
        app.dependency_overrides.clear()

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=other_id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/visual-artifacts/{artifact_id}")
            assert resp.status_code == 403, resp.text
            body = resp.json()
            assert body["error"]["code"] == "FORBIDDEN"
            assert body["error"]["message"] == "생성자만 삭제할 수 있습니다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_realdb_mcp_create_delete_then_get_and_list_exclude():
    """AC4 실증(⭐핵심): MCP sprintable_create_artifact → sprintable_delete_artifact →
    sprintable_get_artifact(더 이상 안 보임, 404) + sprintable_list_artifacts(제외) 왕복.
    라우터의 _get_artifact_or_404(deleted_at.is_(None) 필터, line 186)와 list_artifacts의
    직접 deleted_at 필터(line 290)가 실제로 동작하는지 end-to-end로 실증 — 필터가 깨져 있으면
    (진짜 결함이면) 이 테스트가 실패해야 한다."""
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        # 고정 caller_id — _setup_app(user_id=None)은 매 요청마다 새 랜덤 uuid를 발급해(각 _auth()
        # 클로저 호출 시점 평가) create/delete 요청이 서로 다른 사용자로 인증될 수 있다(생성자-전용
        # 게이트가 자기 자신의 delete까지 403으로 막는 self-testing 함정) — 고정 id로 회피.
        caller_id = uuid.uuid4()
        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"], user_id=caller_id)

        os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp.tools.visual_artifacts import (
            ArtifactNodeInput, CreateArtifactInput, DeleteArtifactInput, GetArtifactInput, ListArtifactsInput,
            create_artifact, delete_artifact, get_artifact, list_artifacts,
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

        async def _delete(path, **kwargs):
            r = await test_http_client.delete(path, **kwargs)
            r.raise_for_status()
            return r.json()["data"]

        orig_post, orig_get, orig_delete = real_client.post, real_client.get, real_client.delete
        real_client.post, real_client.get, real_client.delete = _post, _get, _delete
        try:
            created = json.loads((await create_artifact(CreateArtifactInput(
                title="To Delete", nodes=[ArtifactNodeInput(type="text")],
            )))[0].text)
            artifact_id = created["id"]

            # 삭제 전: list에 보임.
            before = json.loads((await list_artifacts(ListArtifactsInput()))[0].text)
            assert any(a["id"] == artifact_id for a in before)

            del_result = json.loads((await delete_artifact(DeleteArtifactInput(artifact_id=artifact_id)))[0].text)
            assert del_result == {"ok": True, "id": artifact_id}

            # 삭제 후: get_artifact → 404(err() 텍스트로 나옴, exception이 아니라 도구 반환값).
            get_result = await get_artifact(GetArtifactInput(artifact_id=artifact_id))
            get_text = get_result[0].text
            assert get_text.startswith("Error:")
            assert "404" in get_text or "NOT_FOUND" in get_text or "Artifact not found" in get_text

            # 삭제 후: list_artifacts에서 제외.
            after = json.loads((await list_artifacts(ListArtifactsInput()))[0].text)
            assert not any(a["id"] == artifact_id for a in after)
        finally:
            real_client.post, real_client.get, real_client.delete = orig_post, orig_get, orig_delete
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
