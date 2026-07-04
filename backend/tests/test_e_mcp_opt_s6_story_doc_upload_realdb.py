"""E-MCP-OPT S6 (029b7825): story/doc MCP 첨부 업로드 — 실 Postgres + 실 storage.

story: `upload_story_attachment`(chat과 동형) + `update_story`의 mcp-태그 부분집합 선언한도
재검증(S5 #2 처음부터 포함). doc: `upload_doc_attachment`(base64 업로드+즉시 asset 등록 한 호출)
+ `embed_snippet`이 실 TipTap 렌더 계약(data-asset-id/data-filename/data-size/data-mime-type)과
정확히 일치하는지.
"""
from __future__ import annotations

import base64
import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab900000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab900000-0000-0000-0000-000000000002")
STORY = uuid.UUID("ab900000-0000-0000-0000-000000000003")
DOC = uuid.UUID("ab900000-0000-0000-0000-000000000004")
AGENT_IN = uuid.UUID("ab900000-0000-0000-0000-0000000000a1")   # project access 있음
AGENT_OUT = uuid.UUID("ab900000-0000-0000-0000-0000000000a2")  # project access 없음


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(member_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S6SD','s6sd-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_OUT}','{ORG}','agent','AgentOut')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT_IN}','granted')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','test story','backlog','medium')",
        f"INSERT INTO docs (id,org_id,project_id,title,slug,content) VALUES "
        f"('{DOC}','{ORG}','{PROJ}','test doc','test-doc-s6','')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── story ──────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_story_upload_writes_real_bytes_at_s7_path_with_mcp_marker(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.stories import UploadStoryAttachmentRequest, upload_story_attachment
    from app.services.storage import get_storage_provider
    from app.services.asset_registry import DEFAULT_CONTAINER

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            raw = b"\x89PNG story screenshot bytes"
            body = UploadStoryAttachmentRequest(
                content_base64=base64.b64encode(raw).decode(), name="shot.png", content_type="image/png",
            )
            resp = await upload_story_attachment(STORY, body, session=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert resp.size == len(raw)
            prefix = f"org/{ORG}/project/{PROJ}/story/{STORY}/mcp/"
            assert resp.url.startswith(prefix)
            downloaded = await get_storage_provider().download_object(DEFAULT_CONTAINER, resp.url)
            assert downloaded == raw
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_story_upload_no_project_access_403(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.stories import UploadStoryAttachmentRequest, upload_story_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = UploadStoryAttachmentRequest(
                content_base64=base64.b64encode(b"x").decode(), name="f.txt", content_type="text/plain",
            )
            with pytest.raises(HTTPException) as ei:
                await upload_story_attachment(STORY, body, session=s, auth=_auth(AGENT_OUT), org_id=ORG)
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_story_update_rejects_mcp_attachments_over_declared_limit(monkeypatch, tmp_path):
    """S5 #2 와 동일 갭을 story 에서 처음부터 막는지 — 6개(>5) mcp-태그 첨부 참조 update_story 는 400."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.stories import (
        UploadStoryAttachmentRequest,
        upload_story_attachment,
    )
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        uploaded = []
        async with Session() as s:
            for i in range(6):
                raw = b"a" * (1024 * 1024)
                body = UploadStoryAttachmentRequest(
                    content_base64=base64.b64encode(raw).decode(),
                    name=f"f{i}.bin", content_type="application/octet-stream",
                )
                uploaded.append(await upload_story_attachment(
                    STORY, body, session=s, auth=_auth(AGENT_IN), org_id=ORG,
                ))

        async with Session() as s:
            from app.repositories.story import StoryRepository
            from app.routers.stories import update_story
            repo = StoryRepository(s, ORG)
            update_body = StoryUpdate(attachments=uploaded)
            with pytest.raises(HTTPException) as ei:
                await update_story(
                    STORY, update_body, BackgroundTasks(), repo=repo, db=s, auth=_auth(AGENT_IN),
                )
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()


# ── doc ────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_doc_upload_registers_asset_and_returns_correct_embed_snippet(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.docs import UploadDocAttachmentRequest, upload_doc_attachment
    from app.services.storage import get_storage_provider
    from app.services.asset_registry import DEFAULT_CONTAINER

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            raw = b"doc-attached-png-bytes"
            body = UploadDocAttachmentRequest(
                content_base64=base64.b64encode(raw).decode(), name="diagram.png", content_type="image/png",
            )
            resp = await upload_doc_attachment(DOC, body, session=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert resp.size == len(raw)
            assert resp.asset_id is not None
            assert resp.embed_snippet == (
                f'<img data-asset-id="{resp.asset_id}" data-filename="diagram.png" '
                f'data-size="{len(raw)}" data-mime-type="image/png" alt="diagram.png">'
            )
            # asset 실제로 등록됐는지 확인(asset_links 경유 — Asset 존재 자체로 충분)
            row = (await s.execute(
                text("SELECT id FROM assets WHERE id=:aid"), {"aid": str(resp.asset_id)},
            )).first()
            assert row is not None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_upload_non_image_returns_file_div_snippet(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.docs import UploadDocAttachmentRequest, upload_doc_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            raw = b"%PDF-1.4 fake pdf bytes"
            body = UploadDocAttachmentRequest(
                content_base64=base64.b64encode(raw).decode(), name="report.pdf", content_type="application/pdf",
            )
            resp = await upload_doc_attachment(DOC, body, session=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert resp.embed_snippet == (
                f'<div data-type="fileAttachment" data-filename="report.pdf" data-size="{len(raw)}" '
                f'data-mime-type="application/pdf" data-asset-id="{resp.asset_id}"></div>'
            )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_upload_escapes_html_in_filename(monkeypatch, tmp_path):
    """파일명이 doc content(HTML)에 그대로 꽂히므로 injection 방지 — attribute-context escape 필수."""
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.docs import UploadDocAttachmentRequest, upload_doc_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = UploadDocAttachmentRequest(
                content_base64=base64.b64encode(b"x").decode(),
                name='evil"><script>alert(1)</script>.png', content_type="image/png",
            )
            resp = await upload_doc_attachment(DOC, body, session=s, auth=_auth(AGENT_IN), org_id=ORG)
            assert "<script>" not in resp.embed_snippet
            assert "&lt;script&gt;" in resp.embed_snippet
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_doc_upload_no_project_access_403(monkeypatch, tmp_path):
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path))
    from app.routers.docs import UploadDocAttachmentRequest, upload_doc_attachment

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            body = UploadDocAttachmentRequest(
                content_base64=base64.b64encode(b"x").decode(), name="f.txt", content_type="text/plain",
            )
            with pytest.raises(HTTPException) as ei:
                await upload_doc_attachment(DOC, body, session=s, auth=_auth(AGENT_OUT), org_id=ORG)
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()
