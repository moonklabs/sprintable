"""E-MCP-OPT S6: `update_story`/`update_doc` MCP 도구 첨부 파라미터 — 업로드 체이닝/병합 검증.

story: 업로드 결과를 PATCH attachments 에 실을 때 **기존 첨부와 병합**(서버 full-replace 이므로
먼저 GET 으로 기존 목록을 읽어 이어붙임 — 새 첨부가 기존 걸 지우지 않음).
doc: 업로드 응답의 embed_snippet 을 content 끝에 append(현재 content 미제공 시 GET 으로 먼저 읽음).
"""
from __future__ import annotations

import base64
from unittest.mock import AsyncMock, patch

import pytest

from sprintable_mcp.tools import docs as docs_mod
from sprintable_mcp.tools import stories as stories_mod
from sprintable_mcp.tools.docs import UpdateDocInput, update_doc
from sprintable_mcp.tools.stories import UpdateStoryInput, update_story


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _b64(n: int) -> str:
    return base64.b64encode(b"x" * n).decode()


# ── story ──────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_update_story_no_attachments_unchanged_payload():
    args = UpdateStoryInput(story_id="s1", title="new title")
    with patch.object(stories_mod.client, "patch", new=AsyncMock(return_value={})) as m:
        await update_story(args)
        _, kwargs = m.call_args
        assert "attachments" not in kwargs["json"]


@pytest.mark.anyio
async def test_update_story_merges_new_attachments_with_existing():
    args = UpdateStoryInput(
        story_id="s1",
        attachments=[{"content_base64": _b64(4), "name": "new.png", "content_type": "image/png"}],
    )
    existing_attachment = {"url": "org/o/project/p/story/s1/old.png", "name": "old.png", "content_type": "image/png", "size": 10}
    uploaded_attachment = {"url": "org/o/project/p/story/s1/mcp/x-new.png", "name": "new.png", "content_type": "image/png", "size": 4}
    calls: list[tuple] = []

    async def _fake_post(path, json=None):
        calls.append(("post", path, json))
        return uploaded_attachment

    async def _fake_get(path, params=None):
        calls.append(("get", path, None))
        return {"attachments": [existing_attachment]}

    async def _fake_patch(path, json=None):
        calls.append(("patch", path, json))
        return {"id": "s1"}

    with patch.object(stories_mod.client, "post", new=AsyncMock(side_effect=_fake_post)), \
         patch.object(stories_mod.client, "get", new=AsyncMock(side_effect=_fake_get)), \
         patch.object(stories_mod.client, "patch", new=AsyncMock(side_effect=_fake_patch)):
        await update_story(args)

    kinds = [c[0] for c in calls]
    assert kinds == ["post", "get", "patch"]
    patch_body = calls[-1][2]
    assert patch_body["attachments"] == [existing_attachment, uploaded_attachment]


@pytest.mark.anyio
async def test_update_story_upload_failure_returns_error_no_patch():
    args = UpdateStoryInput(
        story_id="s1",
        attachments=[{"content_base64": _b64(4), "name": "new.png", "content_type": "image/png"}],
    )
    with patch.object(stories_mod.client, "post", new=AsyncMock(side_effect=RuntimeError("403"))), \
         patch.object(stories_mod.client, "patch", new=AsyncMock()) as patch_mock:
        result = await update_story(args)
    assert result[0].text.startswith("Error")
    patch_mock.assert_not_awaited()


# ── doc ────────────────────────────────────────────────────────────────────
@pytest.mark.anyio
async def test_update_doc_no_attachments_unchanged_payload():
    args = UpdateDocInput(doc_id="d1", title="new title")
    with patch.object(docs_mod.client, "patch", new=AsyncMock(return_value={})) as m:
        await update_doc(args)
        _, kwargs = m.call_args
        assert "content" not in kwargs["json"]


@pytest.mark.anyio
async def test_update_doc_appends_embed_snippet_to_provided_content():
    args = UpdateDocInput(
        doc_id="d1", content="# my doc\n\nsome text",
        attachments=[{"content_base64": _b64(4), "name": "shot.png", "content_type": "image/png"}],
    )
    upload_result = {
        "asset_id": "AID-1", "filename": "shot.png", "size": 4, "mime": "image/png",
        "embed_snippet": '<img data-asset-id="AID-1" data-filename="shot.png" data-size="4" data-mime-type="image/png" alt="shot.png">',
    }
    with patch.object(docs_mod.client, "post", new=AsyncMock(return_value=upload_result)), \
         patch.object(docs_mod.client, "patch", new=AsyncMock(return_value={})) as patch_mock:
        await update_doc(args)
    _, kwargs = patch_mock.call_args
    assert kwargs["json"]["content"] == "# my doc\n\nsome text\n" + upload_result["embed_snippet"]


@pytest.mark.anyio
async def test_update_doc_fetches_existing_content_when_not_provided():
    """content 미제공 시 현재 저장된 content 를 먼저 읽어 그 뒤에 append(기존 본문 유지)."""
    args = UpdateDocInput(
        doc_id="d1",
        attachments=[{"content_base64": _b64(4), "name": "shot.png", "content_type": "image/png"}],
    )
    upload_result = {
        "asset_id": "AID-1", "filename": "shot.png", "size": 4, "mime": "image/png",
        "embed_snippet": '<img data-asset-id="AID-1" alt="shot.png">',
    }
    calls: list[tuple] = []

    async def _fake_post(path, json=None):
        calls.append(("post", path))
        return upload_result

    async def _fake_get(path, params=None):
        calls.append(("get", path))
        return {"content": "existing body"}

    async def _fake_patch(path, json=None):
        calls.append(("patch", path, json))
        return {}

    with patch.object(docs_mod.client, "post", new=AsyncMock(side_effect=_fake_post)), \
         patch.object(docs_mod.client, "get", new=AsyncMock(side_effect=_fake_get)), \
         patch.object(docs_mod.client, "patch", new=AsyncMock(side_effect=_fake_patch)):
        await update_doc(args)

    patch_call = next(c for c in calls if c[0] == "patch")
    assert patch_call[2]["content"] == f"existing body\n{upload_result['embed_snippet']}"


@pytest.mark.anyio
async def test_update_doc_upload_failure_returns_error_no_patch():
    args = UpdateDocInput(
        doc_id="d1",
        attachments=[{"content_base64": _b64(4), "name": "shot.png", "content_type": "image/png"}],
    )
    with patch.object(docs_mod.client, "post", new=AsyncMock(side_effect=RuntimeError("403"))), \
         patch.object(docs_mod.client, "patch", new=AsyncMock()) as patch_mock:
        result = await update_doc(args)
    assert result[0].text.startswith("Error")
    patch_mock.assert_not_awaited()
