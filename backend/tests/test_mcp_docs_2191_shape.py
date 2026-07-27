"""story #2191 후속: GET /api/v2/docs 응답이 bare array → {data, meta}(#2231 규약 A)로
바뀌었다. sprintable_mcp/tools/docs.py의 list_docs·get_doc·search_docs 셋 다 이 엔드포인트를
호출하므로(같은 병 #2195 MCP 대응과 동형) 언랩 + has_more 안내를 고정한다.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_list_docs_unwraps_new_data_meta_shape_no_has_more():
    from sprintable_mcp.tools.docs import ListDocsInput, list_docs

    new_shape = {
        "data": [{"id": "d1", "title": "hello", "slug": "hello"}],
        "meta": {"has_more": False, "next_cursor": None},
    }
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value=new_shape)
        out = await list_docs(ListDocsInput())

    parsed = json.loads(out[0].text)
    assert isinstance(parsed, list)
    assert parsed == new_shape["data"]
    assert len(out) == 1  # has_more=False면 안내 블록 없음


@pytest.mark.anyio
async def test_list_docs_signals_has_more_with_next_page_hint():
    from sprintable_mcp.tools.docs import ListDocsInput, list_docs

    new_shape = {
        "data": [{"id": "d1", "title": "hello", "slug": "hello"}],
        "meta": {"has_more": True, "next_cursor": "0:11111111-1111-1111-1111-111111111111"},
    }
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value=new_shape)
        out = await list_docs(ListDocsInput())

    parsed = json.loads(out[0].text)
    assert parsed == new_shape["data"]
    assert len(out) == 2
    assert "0:11111111-1111-1111-1111-111111111111" in out[1].text
    assert "더 있음" in out[1].text


@pytest.mark.anyio
async def test_list_docs_passes_cursor_through():
    from sprintable_mcp.tools.docs import ListDocsInput, list_docs

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value={"data": [], "meta": {"has_more": False, "next_cursor": None}})
        await list_docs(ListDocsInput(cursor="0:abc"))

    _, kwargs = mock_client.get.call_args
    assert kwargs["params"]["cursor"] == "0:abc"


@pytest.mark.anyio
async def test_get_doc_unwraps_new_shape_for_slug_lookup():
    """8a8e881a 회귀 가드 + #2191: {data,meta} 봉투에서도 summaries[0] 인덱싱이 안 터진다."""
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    doc_id = "11111111-1111-1111-1111-111111111111"
    list_shape = {"data": [{"id": doc_id, "title": "Handoff", "slug": "handoff"}], "meta": {"has_more": False, "next_cursor": None}}
    doc_resp = {"id": doc_id, "title": "Handoff", "slug": "handoff", "content": "FULL BODY"}

    async def fake_get(path, params=None):
        return list_shape if path == "/api/v2/docs" else doc_resp

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await get_doc(GetDocInput(slug="handoff"))

    parsed = json.loads(out[0].text)
    assert parsed["content"] == "FULL BODY"


@pytest.mark.anyio
async def test_get_doc_not_found_with_new_shape():
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value={"data": [], "meta": {"has_more": False, "next_cursor": None}})
        out = await get_doc(GetDocInput(slug="nope"))

    assert "not found" in out[0].text.lower()


@pytest.mark.anyio
async def test_search_docs_unwraps_and_never_signals_has_more():
    """search_full_text 분기는 의도적으로 커서 미지원 — has_more 안내가 절대 안 붙는다."""
    from sprintable_mcp.tools.docs import SearchDocsInput, search_docs

    new_shape = {
        "data": [{"id": "d1", "title": "hello", "snippet": "..."}],
        "meta": {"has_more": False, "next_cursor": None},
    }
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.get = AsyncMock(return_value=new_shape)
        out = await search_docs(SearchDocsInput(query="hello"))

    parsed = json.loads(out[0].text)
    assert parsed == new_shape["data"]
    assert len(out) == 1
