"""story #2668(B3, human-event-definer-design-v1) — 결재 상신이 REST(POST /docs/{id}/transition)를
알아야만 가능해 MCP 도구 목록만 봐서는 발견이 안 됐다(오늘 PO 재발 2회의 구조 원인). 신설
`sprintable_submit_for_approval` MCP 도구 + create_doc/update_doc 응답의 next_action 실행
가능 명세({tool, args}) 동봉을 고정한다.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── _attach_submit_for_approval_next_action — 순수 함수 축 ───────────────────


def test_attach_next_action_for_draft_doc():
    from sprintable_mcp.tools.docs import _attach_submit_for_approval_next_action

    doc = {"id": "doc-1", "status": "draft", "title": "x"}
    _attach_submit_for_approval_next_action(doc)
    assert doc["next_action"] == {
        "tool": "sprintable_submit_for_approval",
        "args": {"doc_id": "doc-1"},
    }


def test_no_next_action_for_non_draft_doc():
    from sprintable_mcp.tools.docs import _attach_submit_for_approval_next_action

    doc = {"id": "doc-1", "status": "pending", "title": "x"}
    _attach_submit_for_approval_next_action(doc)
    assert "next_action" not in doc


def test_no_next_action_without_id_defensive():
    from sprintable_mcp.tools.docs import _attach_submit_for_approval_next_action

    doc = {"status": "draft", "title": "x"}  # id 없는 비정상 응답
    _attach_submit_for_approval_next_action(doc)
    assert "next_action" not in doc


# ─── create_doc / update_doc — next_action 동봉 실배선 ─────────────────────────


@pytest.mark.anyio
async def test_create_doc_response_carries_submit_for_approval_next_action():
    from sprintable_mcp.tools.docs import CreateDocInput, create_doc

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.require_project_id = lambda: "proj"
        mock_client.post = AsyncMock(return_value={"id": "doc-1", "status": "draft", "title": "x"})
        out = await create_doc(CreateDocInput(title="x", slug="x"))

    parsed = json.loads(out[0].text)
    assert parsed["next_action"] == {
        "tool": "sprintable_submit_for_approval",
        "args": {"doc_id": "doc-1"},
    }


@pytest.mark.anyio
async def test_update_doc_response_carries_submit_for_approval_next_action_when_still_draft():
    from sprintable_mcp.tools.docs import UpdateDocInput, update_doc

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.patch = AsyncMock(return_value={"id": "doc-1", "status": "draft", "title": "x2"})
        out = await update_doc(UpdateDocInput(doc_id="doc-1", title="x2"))

    parsed = json.loads(out[0].text)
    assert parsed["next_action"]["tool"] == "sprintable_submit_for_approval"


# ─── submit_for_approval — REST 래핑 + 게이트 실물 동봉 ────────────────────────


@pytest.mark.anyio
async def test_submit_for_approval_calls_transition_and_attaches_real_pending_gate():
    from sprintable_mcp.tools.docs import SubmitForApprovalInput, submit_for_approval

    doc_resp = {"id": "doc-1", "status": "pending", "title": "x"}
    gate_resp = [{"id": "gate-1", "status": "pending", "work_item_id": "doc-1", "work_item_type": "doc"}]
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.post = AsyncMock(return_value=doc_resp)
        mock_client.get = AsyncMock(return_value=gate_resp)
        out = await submit_for_approval(SubmitForApprovalInput(doc_id="doc-1"))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/docs/doc-1/transition", json={"status": "pending"},
    )
    mock_client.get.assert_awaited_once_with(
        "/api/v2/gates",
        params={"work_item_id": "doc-1", "work_item_type": "doc", "status": "pending"},
    )
    parsed = json.loads(out[0].text)
    assert parsed["doc"] == doc_resp
    assert parsed["gate"] == gate_resp[0]


@pytest.mark.anyio
async def test_submit_for_approval_gate_none_when_lookup_empty_no_crash():
    """AC1의 "게이트 실물 확認"이 실패해도(레이스·조회 지연 등) 도구 자체는 크래시하지 않고
    gate=None으로 정직하게 보고한다 — doc 전이 자체는 성공했으므로 그 결과는 살린다."""
    from sprintable_mcp.tools.docs import SubmitForApprovalInput, submit_for_approval

    doc_resp = {"id": "doc-2", "status": "pending", "title": "y"}
    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.post = AsyncMock(return_value=doc_resp)
        mock_client.get = AsyncMock(return_value=[])
        out = await submit_for_approval(SubmitForApprovalInput(doc_id="doc-2"))

    parsed = json.loads(out[0].text)
    assert parsed["doc"] == doc_resp
    assert parsed["gate"] is None


@pytest.mark.anyio
async def test_submit_for_approval_transition_error_surfaces_as_err_not_crash():
    from sprintable_mcp.tools.docs import SubmitForApprovalInput, submit_for_approval

    with patch("sprintable_mcp.tools.docs.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=RuntimeError("HTTP 422: INVALID_DOC_TRANSITION"))
        out = await submit_for_approval(SubmitForApprovalInput(doc_id="doc-3"))

    assert out[0].text.startswith("Error:")
    assert "INVALID_DOC_TRANSITION" in out[0].text


# ─── mcp_toolset.py — tool_group 분류(핵심 회귀축, propose_canonical_version류 함정과 동형) ────


def test_submit_for_approval_classified_into_docs_group_not_core():
    """"submit_for_approval"엔 "doc" substring이 없다 — 키워드에 명시 추가가 안 됐으면 core로
    떨어져 role-scope 키(scope=["docs"])로 recruit된 에이전트가 이 도구를 403으로 못 부른다.
    이 스토리가 고치려던 "발견 못 함"과 같은 결의 새 차단을 미리 잡는다."""
    from app.services.mcp_toolset import tool_group

    assert tool_group("sprintable_submit_for_approval") == "docs"


def test_docs_scope_key_is_allowed_to_call_submit_for_approval():
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_submit_for_approval", ["docs"]) is True


def test_stories_only_scope_key_is_blocked_from_submit_for_approval():
    from app.services.mcp_toolset import is_tool_allowed

    assert is_tool_allowed("sprintable_submit_for_approval", ["stories"]) is False
