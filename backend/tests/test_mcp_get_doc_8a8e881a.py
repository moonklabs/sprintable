"""8a8e881a: MCP get_doc 본문(content) surface 회귀 가드.

기존: get_doc이 list 엔드포인트(/api/v2/docs?slug=)=DocSummary(메타·snippet만)를 반환 →
에이전트가 서로의 doc 본문을 못 읽음. 수정: slug→id 해소 후 GET /{id}(DocResponse·content) surface.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_get_doc_surfaces_content():
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    doc_id = "11111111-1111-1111-1111-111111111111"
    list_resp = [{"id": doc_id, "title": "Handoff", "slug": "handoff", "snippet": "intro..."}]
    doc_resp = {
        "id": doc_id, "title": "Handoff", "slug": "handoff", "tags": [],
        "content": "FULL BODY — 핸드오프 계약 내용", "content_format": "markdown",
        "updated_at": "2026-06-15T00:00:00Z",
    }
    calls: list[tuple] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return list_resp if path == "/api/v2/docs" else doc_resp

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.project_id = "proj"
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await get_doc(GetDocInput(slug="handoff"))

    parsed = json.loads(out[0].text)
    # 본문(content) surface — 핵심 AC
    assert parsed["content"] == "FULL BODY — 핸드오프 계약 내용"
    # 메타데이터 유지(기존 소비자 무영향)
    assert parsed["id"] == doc_id
    assert parsed["title"] == "Handoff"
    assert parsed["slug"] == "handoff"
    # slug→id 해소 후 GET /{id} 경로 호출 확인
    assert any(p == f"/api/v2/docs/{doc_id}" for p, _ in calls)


@pytest.mark.anyio
async def test_get_doc_not_found_returns_error():
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.project_id = "proj"
        mock_client.get = AsyncMock(return_value=[])
        out = await get_doc(GetDocInput(slug="nope"))

    assert "not found" in out[0].text.lower()
