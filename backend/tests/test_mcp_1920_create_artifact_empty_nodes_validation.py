"""story #1920: create_artifact 빈 nodes 검증 — 빈 산출물 생성 방지.

배경: CreateArtifactRequest.nodes에 최소 길이 제약이 없어 REST 직접 호출은 nodes=[]로,
MCP sprintable_create_artifact 도구는 `if args.nodes: body["nodes"] = [...]`(falsy면 키
자체 미전송)로 각각 빈-nodes 산출물을 조용히 생성할 수 있었다(8de4e981류 사고 재발 지점).
그 사고 자체의 사후처리(소프트 삭제 도구)는 #1922로 이미 별도 완료 — 이 스토리는 순수
"애초에 못 만들게" 재발 방지다.

수정: backend/app/schemas/visual_artifact.py::CreateArtifactRequest.nodes를
`Field(min_length=1)`로 바꿔(기존 `= []` 디폴트 제거) — loop.py::LoopDecisionRequest.decisions
와 동일 하우스 컨벤션. 스키마 레벨 제약이라 FastAPI가 기본 RequestValidationError → 422로
거절한다(라우터 400 커스텀 아님 — 이 파일의 기존 field_validator들과 동일하게 스키마 레벨
422가 이 코드베이스 전역 컨벤션, docs/AC의 "400"은 문면 표현으로 다루지 않음).

MCP 경로 검증: api_client.py::_extract_error_message가 이미 FastAPI 422 검증 배열 shape
(`{"detail": [{"loc","msg","type"}]}`)을 가독 텍스트로 뽑는 로직(shape 3, `_format_validation_errors`)
을 갖고 있어 이 새 제약도 별도 코드 없이 그대로 커버된다 — 아래에서 실제 값으로 재확인.
"""
from __future__ import annotations

import json
import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from app.schemas.visual_artifact import CreateArtifactRequest
from sprintable_mcp.api_client import SprintableApiError, _extract_error_message
from sprintable_mcp.tools import visual_artifacts as va


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 0. 스키마 레벨 — 빈 리스트/누락 모두 거부, 유효 nodes는 통과 ──────────────────

def test_schema_rejects_empty_nodes_list():
    with pytest.raises(ValidationError) as exc_info:
        CreateArtifactRequest(title="t", nodes=[])
    errors = exc_info.value.errors()
    assert len(errors) == 1
    assert errors[0]["type"] == "too_short"
    assert errors[0]["loc"] == ("nodes",)


def test_schema_rejects_omitted_nodes():
    with pytest.raises(ValidationError) as exc_info:
        CreateArtifactRequest(title="t")
    errors = exc_info.value.errors()
    assert len(errors) == 1
    assert errors[0]["loc"] == ("nodes",)
    assert errors[0]["type"] == "missing"


def test_schema_accepts_one_or_more_nodes():
    """회귀 가드 — 정상 nodes 경로는 완전 무회귀."""
    req = CreateArtifactRequest(title="t", nodes=[{"type": "text", "props": {"content": "hi"}}])
    assert len(req.nodes) == 1
    assert req.nodes[0].type == "text"

    req2 = CreateArtifactRequest(
        title="t",
        nodes=[{"type": "text"}, {"type": "html_blob", "props": {"html": "<div/>"}}],
    )
    assert len(req2.nodes) == 2


# ── 1. FastAPI 422 검증 배열이 api_client._extract_error_message에서 가독 텍스트로 나오는지 ──
# (backend/sprintable_mcp/api_client.py::_format_validation_errors — "shape 3"가 이 값을 커버)

def test_extract_error_message_readable_for_empty_nodes_422():
    body = {
        "detail": [
            {
                "type": "too_short",
                "loc": ["body", "nodes"],
                "msg": "List should have at least 1 item after validation, not 0",
                "input": [],
                "ctx": {"field_type": "List", "min_length": 1, "actual_length": 0},
            }
        ]
    }
    msg = _extract_error_message(422, body)
    # "Sprintable API 422"류 불투명 삼킴이 아니라 field명 + 사람이 읽을 수 있는 사유가 나와야 한다.
    assert msg == "Sprintable API 422 validation: nodes: List should have at least 1 item after validation, not 0"
    assert "nodes" in msg
    assert msg != "Sprintable API 422"


def test_extract_error_message_readable_for_omitted_nodes_422():
    body = {
        "detail": [
            {"type": "missing", "loc": ["body", "nodes"], "msg": "Field required", "input": {"title": "t"}},
        ]
    }
    msg = _extract_error_message(422, body)
    assert msg == "Sprintable API 422 validation: nodes: Field required"
    assert msg != "Sprintable API 422"


# ── 2. MCP 도구 레벨(mock) — 빈/누락 nodes로 백엔드가 SprintableApiError를 던지면 err()로 ──
#    가독 텍스트가 그대로 나오는지 (test_mcp_1922_delete_artifact_tool.py와 동형 패턴)

def _error_client(exc: Exception):
    c = MagicMock()
    c.project_id = "proj-1"
    c.require_project_id = MagicMock(return_value="proj-1")
    c.post = AsyncMock(side_effect=exc)
    return c


async def test_mcp_create_artifact_empty_nodes_readable_error():
    readable = "Sprintable API 422 validation: nodes: List should have at least 1 item after validation, not 0"
    client = _error_client(SprintableApiError(422, readable))
    args = va.CreateArtifactInput(title="Empty Draft", nodes=[])
    with patch.object(va, "client", client):
        out = await va.create_artifact(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "nodes" in text
    assert "List should have at least 1 item" in text
    # 불투명 실패 반증 — 검증 배열이 삼켜져 "422"만 남는 회귀를 막는다.
    assert text != "Error: Sprintable API 422"


async def test_mcp_create_artifact_omitted_nodes_readable_error():
    """args.nodes=None(도구 시그니처상 선택제) → `if args.nodes:`가 falsy라 body에 "nodes" 키
    자체가 실리지 않는다(원래 사고 root cause 경로) — 백엔드가 이제 "missing"으로 거절하고,
    그 사유가 여전히 가독 텍스트로 나와야 한다."""
    readable = "Sprintable API 422 validation: nodes: Field required"
    client = _error_client(SprintableApiError(422, readable))
    args = va.CreateArtifactInput(title="No Nodes At All")
    assert args.nodes is None
    with patch.object(va, "client", client):
        out = await va.create_artifact(args)
    text = out[0].text
    assert text.startswith("Error:")
    assert "nodes" in text
    assert "Field required" in text


async def test_mcp_create_artifact_success_with_nodes_unaffected():
    """회귀 가드 — 정상 nodes 경로는 MCP 레벨에서도 완전 무회귀."""
    client = MagicMock()
    client.project_id = "proj-1"
    client.require_project_id = MagicMock(return_value="proj-1")
    client.post = AsyncMock(return_value={"id": "a1", "title": "With Nodes"})
    args = va.CreateArtifactInput(
        title="With Nodes",
        nodes=[va.ArtifactNodeInput(type="text", props={"content": "hi"})],
    )
    with patch.object(va, "client", client):
        out = await va.create_artifact(args)
    data = json.loads(out[0].text)
    assert data == {"id": "a1", "title": "With Nodes"}
    sent_body = client.post.call_args.kwargs["json"]
    assert sent_body["nodes"] == [{"type": "text", "props": {"content": "hi"}}]


# ═══════════════════════════════════════════════════════════════════════════
# realdb: 라우터 실 HTTP 왕복 + MCP 실 왕복(모의 없이) — 422 거절 + 성공 경로 무회귀
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
async def test_realdb_create_artifact_empty_nodes_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "Empty", "nodes": []})
            assert resp.status_code == 422, resp.text
            body = resp.json()
            assert body["detail"][0]["loc"] == ["body", "nodes"]
            assert "at least 1 item" in body["detail"][0]["msg"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_realdb_create_artifact_omitted_nodes_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/visual-artifacts", json={"title": "No Nodes Field"})
            assert resp.status_code == 422, resp.text
            body = resp.json()
            assert body["detail"][0]["loc"] == ["body", "nodes"]
            assert body["detail"][0]["type"] == "missing"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_realdb_create_artifact_with_nodes_still_succeeds_201():
    """회귀 가드 — 이 스토리 이전에도 통과하던 정상 경로가 여전히 201로 통과해야 한다."""
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
                json={"title": "Has Nodes", "nodes": [{"type": "text", "props": {"content": "hi"}}]},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()["data"]
            assert len(body["nodes"]) == 1
            assert body["nodes"][0]["type"] == "text"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytestmark_realdb
@pytest.mark.anyio
async def test_realdb_mcp_create_artifact_empty_nodes_readable_error_no_mock():
    """AC 핵심: 모킹 없이 실 HTTP 왕복으로 MCP sprintable_create_artifact가 nodes=[]를
    거절할 때 반환 텍스트가 사람이 읽을 수 있는지(불투명 '422'가 아닌지) 실증.

    주의: CreateArtifactInput(nodes=[])는 도구 쪽 `if args.nodes:`(falsy 가드, 이 스토리가
    다루지 않는 기존 코드)가 빈 리스트를 "미지정"과 동일하게 취급해 body에 "nodes" 키
    자체를 싣지 않는다 — 원래 사고의 root cause 경로 그대로다. 그래서 서버는 too_short가
    아니라 missing으로 거절하는데, 이 테스트의 초점은 정확한 에러 타입이 아니라 "그 결과가
    사람이 읽을 수 있는 텍스트로 나오는가"이므로 무관하다."""
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["project_id"])

        os.environ.setdefault("SPRINTABLE_API_URL", "http://test")
        os.environ.setdefault("AGENT_API_KEY", "sk_test")

        from sprintable_mcp.tools.visual_artifacts import CreateArtifactInput, create_artifact
        from sprintable_mcp import api_client as api_client_mod
        from sprintable_mcp.api_client import SprintableApiError, _extract_error_message

        transport = httpx.ASGITransport(app=app)
        real_client = api_client_mod.client
        test_http_client = httpx.AsyncClient(transport=transport, base_url="http://test")

        async def _post(path, **kwargs):
            r = await test_http_client.post(path, **kwargs)
            if not r.is_success:
                body: object
                try:
                    body = r.json()
                except Exception:
                    body = r.text
                raise SprintableApiError(r.status_code, _extract_error_message(r.status_code, body), body)
            return r.json()["data"]

        orig_post = real_client.post
        real_client.post = _post
        try:
            result = await create_artifact(CreateArtifactInput(title="Empty Draft", nodes=[]))
            text = result[0].text
            assert text.startswith("Error:")
            assert "nodes" in text
            assert "Field required" in text  # falsy 가드 경로 → "missing"(위 docstring 참조)
            assert text != "Error: Sprintable API 422"
        finally:
            real_client.post = orig_post
            await test_http_client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
