"""Part B b1574f5a: 문서 공유 공개 토큰 — 공개 read 계약(404/410·메타 누출 0) + 관리 응답.

DB 의존 라이프사이클(1 active·regenerate revoke·audit)은 실 Postgres e2e 로 별도 검증.
여기선 mock 기반으로 공개 계약(보안 표면)·resolve 분기·응답 shape 을 고정.
"""
from __future__ import annotations

import contextlib
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.doc import PublicDocResponse, ShareStatusResponse
from app.services import doc_share


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _exec_returning(value):
    """db.execute(...) → result.scalar_one_or_none()==value 인 AsyncMock 결과."""
    res = MagicMock()
    res.scalar_one_or_none.return_value = value
    return res


def _db_with(results):
    """db.execute 가 호출 순서대로 results 를 반환하는 AsyncMock 세션."""
    db = MagicMock()
    seq = list(results)
    async def _execute(*a, **k):
        return seq.pop(0) if seq else _exec_returning(None)
    db.execute = AsyncMock(side_effect=_execute)
    return db


# ── resolve_public 분기 (보안 핵심) ───────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_public_unknown_token_404():
    db = _db_with([_exec_returning(None)])  # 토큰 없음
    with pytest.raises(doc_share.ShareTokenError) as ei:
        await doc_share.resolve_public(db, "nope")
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_resolve_public_revoked_token_410():
    tok = SimpleNamespace(status="revoked", doc_id=uuid.uuid4())
    db = _db_with([_exec_returning(tok)])
    with pytest.raises(doc_share.ShareTokenError) as ei:
        await doc_share.resolve_public(db, "t")
    assert ei.value.status_code == 410


@pytest.mark.anyio
async def test_resolve_public_doc_deleted_410():
    tok = SimpleNamespace(status="active", doc_id=uuid.uuid4())
    db = _db_with([_exec_returning(tok), _exec_returning(None)])  # 토큰 active, doc 미존재(삭제)
    with pytest.raises(doc_share.ShareTokenError) as ei:
        await doc_share.resolve_public(db, "t")
    assert ei.value.status_code == 410


@pytest.mark.anyio
async def test_resolve_public_active_returns_doc():
    doc = SimpleNamespace(title="T", content="C", content_format="markdown")
    tok = SimpleNamespace(status="active", doc_id=uuid.uuid4())
    db = _db_with([_exec_returning(tok), _exec_returning(doc)])
    out = await doc_share.resolve_public(db, "t")
    assert out.title == "T"


# ── 메타 누출 0: 공개 응답 필드 집합 고정 ──────────────────────────────────────

def test_public_response_exposes_only_three_fields():
    fields = set(PublicDocResponse.model_fields.keys())
    assert fields == {"title", "content", "content_format"}
    # project_id/org_id/created_by/slug/tags 등 누출 금지
    for leak in ("project_id", "org_id", "created_by", "slug", "id", "assignee_id"):
        assert leak not in fields


# ── 공개 엔드포인트 (TestClient) — 404/410/200 + 비인증 ─────────────────────────

async def _public_client():
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.dependencies.database import get_db

    async def override_db():
        yield MagicMock()

    app.dependency_overrides[get_db] = override_db
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test"), app


@pytest.mark.anyio
async def test_public_endpoint_200_no_auth():
    client, app = await _public_client()
    doc = SimpleNamespace(title="Hello", content="# Hi", content_format="markdown")
    try:
        with patch("app.services.doc_share.resolve_public", new=AsyncMock(return_value=doc)):
            r = await client.get("/api/v2/public/docs/sometoken")  # Authorization 헤더 없음
        assert r.status_code == 200
        body = r.json()
        assert body == {"title": "Hello", "content": "# Hi", "content_format": "markdown"}
    finally:
        app.dependency_overrides.clear()
        await client.aclose()


@pytest.mark.anyio
async def test_public_endpoint_404_and_410():
    client, app = await _public_client()
    try:
        with patch("app.services.doc_share.resolve_public",
                   new=AsyncMock(side_effect=doc_share.ShareTokenError(404, "x"))):
            assert (await client.get("/api/v2/public/docs/unknown")).status_code == 404
        with patch("app.services.doc_share.resolve_public",
                   new=AsyncMock(side_effect=doc_share.ShareTokenError(410, "x"))):
            assert (await client.get("/api/v2/public/docs/revoked")).status_code == 410
    finally:
        app.dependency_overrides.clear()
        await client.aclose()


@pytest.mark.anyio
async def test_public_endpoint_oversize_token_404():
    client, app = await _public_client()
    try:
        r = await client.get("/api/v2/public/docs/" + "a" * 200)
        assert r.status_code == 404
    finally:
        app.dependency_overrides.clear()
        await client.aclose()


# ── 관리 응답 shape (_share_resp) ──────────────────────────────────────────────

def test_share_resp_enabled_with_url(monkeypatch):
    from app.routers.docs import _share_resp
    monkeypatch.setenv("NEXT_PUBLIC_APP_URL", "https://app.sprintable.ai")
    tok = SimpleNamespace(token="aB3xToken")
    resp = _share_resp(tok)
    assert resp.enabled is True and resp.token == "aB3xToken"
    assert resp.share_url == "https://app.sprintable.ai/share/aB3xToken"


def test_share_resp_disabled():
    from app.routers.docs import _share_resp
    resp = _share_resp(None)
    assert resp.enabled is False and resp.token is None
