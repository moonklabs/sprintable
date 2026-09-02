"""story #3324(d37d1f09) — MCP `sprintable_get_doc`가 slug만 받아, 이벤트 payload·참조
토큰(entity:doc:id)·게이트 neutral_facts가 주는 doc id로는 «Doc not found»가 나던 결함
처방. 담롱·PO 둘 다 3바퀴 같은 자리에서 걸림(PO는 search_docs로 slug를 되짚어야 했다).

처방: `doc_id`(uuid) 인자 추가 — slug와 택1. `doc_id`가 오면 slug 해소(list+필터) 단계
자체를 건너뛰고 GET /api/v2/docs/{doc_id}로 직행(신규 REST 0, 기존 배선 재사용). slug
경로는 완전 무변경(회귀 0). 둘 다 없으면 조용히 통과시키지 않고 pydantic ValidationError로
명시 거부(ConversationScopedInput의 conversation_id/thread_id 검증과 동형 관례)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError


@pytest.fixture
def anyio_backend():
    return "asyncio"


_DOC_ID = "11111111-1111-1111-1111-111111111111"
_DOC_RESP = {
    "id": _DOC_ID, "title": "Handoff", "slug": "handoff", "tags": [],
    "content": "FULL BODY — 핸드오프 계약 내용", "content_format": "markdown",
    "updated_at": "2026-06-15T00:00:00Z",
}


@pytest.mark.anyio
async def test_get_doc_by_doc_id_skips_slug_resolution_and_hits_id_endpoint_directly():
    """⭐AC1 핵심 — doc_id를 주면 slug 해소(list+필터) 호출 없이 곧장 GET /{id}로 간다(이벤트
    payload가 주는 id 그대로 열림)."""
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    calls: list[tuple] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return _DOC_RESP

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.project_id = "proj"
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await get_doc(GetDocInput(doc_id=_DOC_ID))

    parsed = json.loads(out[0].text)
    assert parsed["content"] == "FULL BODY — 핸드오프 계약 내용"
    assert parsed["id"] == _DOC_ID
    # slug 해소용 list 엔드포인트(/api/v2/docs)를 전혀 호출하지 않았다 — 단일 호출로 직행.
    assert calls == [(f"/api/v2/docs/{_DOC_ID}", None)]


@pytest.mark.anyio
async def test_get_doc_slug_path_unchanged_regression():
    """AC1 회귀 0 — slug만 준 기존 경로는 완전 무변경(list+필터 후 GET /{id})."""
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    list_resp = [{"id": _DOC_ID, "title": "Handoff", "slug": "handoff", "snippet": "intro..."}]
    calls: list[tuple] = []

    async def fake_get(path, params=None):
        calls.append((path, params))
        return list_resp if path == "/api/v2/docs" else _DOC_RESP

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.project_id = "proj"
        mock_client.get = AsyncMock(side_effect=fake_get)
        out = await get_doc(GetDocInput(slug="handoff"))

    parsed = json.loads(out[0].text)
    assert parsed["content"] == "FULL BODY — 핸드오프 계약 내용"
    assert calls[0][0] == "/api/v2/docs"
    assert calls[1][0] == f"/api/v2/docs/{_DOC_ID}"


@pytest.mark.anyio
async def test_get_doc_neither_slug_nor_doc_id_raises_explicit_error():
    """AC1 — 둘 다 없으면 명시 에러(조용히 통과·조용히 실패 둘 다 아님)."""
    from sprintable_mcp.tools.docs import GetDocInput

    with pytest.raises(ValidationError, match="slug 또는 doc_id"):
        GetDocInput()


@pytest.mark.anyio
async def test_get_doc_by_doc_id_not_found_surfaces_error():
    """doc_id 경로도 존재하지 않는 id면 err()로 에러가 뜬다(BE 404가 client.get에서 예외로
    전파되는 기존 관용구 재사용 — get_chat_message 등과 동형)."""
    from sprintable_mcp.tools.docs import GetDocInput, get_doc

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.project_id = "proj"
        mock_client.get = AsyncMock(side_effect=Exception("404 Not Found"))
        out = await get_doc(GetDocInput(doc_id="99999999-9999-9999-9999-999999999999"))

    assert "error" in out[0].text.lower()


def test_get_doc_registered_description_documents_doc_id():
    """도구 설명이 doc_id 지원을 명시한다(온보딩 표면 — 도구 발견 시점에 알 수 있어야 함)."""
    from sprintable_mcp.server import _TOOL_DEFS

    matches = [t for t in _TOOL_DEFS if t[0] == "sprintable_get_doc"]
    assert len(matches) == 1
    _name, description, _input_model, _fn = matches[0]
    assert "doc_id" in description
