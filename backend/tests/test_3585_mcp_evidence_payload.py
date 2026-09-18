"""story #3585(MCP·customer-zero, 페드루 PO 確定 2026-09-06) — MCP `sprintable_add_
evidence`에 `payload` additive. REST `POST /api/v2/evidence`는 이미 받는 구조화
페이로드(type="report"+payload.kind="verification_sheet"+items — story #3561)가
MCP엔 아예 없어 고객 에이전트가 검증 시트를 MCP로 못 만들었다(3573 표본 evidence
0건의 원인). 이 파일은 그 갭이 닫혔음을 고정한다 — REST 검증 로직은 여기서
재구현하지 않는다(evidence.py 라우터가 SSOT, 이 MCP 도구는 순수 얇은 래핑).

test_2668_mcp_submit_for_approval.py::test_submit_for_approval_* 패턴과 동형
(client.post mock, additive 회귀 없음 확認)."""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_add_evidence_without_payload_sends_request_body_unchanged():
    """additive 회귀 0 — payload 생략 시 기존 요청 body(payload 키 자체가 없음)가
    한 글자도 안 바뀐다."""
    from sprintable_mcp.tools.evidence import AddEvidenceInput, add_evidence

    with patch("sprintable_mcp.tools.evidence.client") as mock_client:
        mock_client.post = AsyncMock(return_value={"id": "ev-1"})
        await add_evidence(AddEvidenceInput(
            work_item_id="story-1", work_item_type="story", type="pr", ref="https://github.com/x/y/pull/1",
        ))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/evidence",
        json={"work_item_id": "story-1", "work_item_type": "story", "type": "pr", "ref": "https://github.com/x/y/pull/1"},
    )


@pytest.mark.anyio
async def test_add_evidence_with_verification_sheet_payload_forwards_to_rest():
    """PO 確定 본체 — payload를 넘기면 REST body에 그대로 실린다(변형·재구현 0)."""
    from sprintable_mcp.tools.evidence import AddEvidenceInput, add_evidence

    sheet = {"kind": "verification_sheet", "items": [{"name": "로그인 흐름", "verdict": "pass"}]}
    with patch("sprintable_mcp.tools.evidence.client") as mock_client:
        mock_client.post = AsyncMock(return_value={"id": "ev-2", "payload": sheet})
        out = await add_evidence(AddEvidenceInput(
            work_item_id="story-1", work_item_type="story", type="report", ref="검증 시트", payload=sheet,
        ))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/evidence",
        json={
            "work_item_id": "story-1", "work_item_type": "story", "type": "report", "ref": "검증 시트",
            "payload": sheet,
        },
    )
    parsed = json.loads(out[0].text)
    assert parsed["payload"] == sheet


@pytest.mark.anyio
async def test_add_evidence_payload_with_other_optional_fields_all_forwarded():
    """payload가 source/note/artifact_id와 동시에 와도 전부 유지(상호배타 0)."""
    from sprintable_mcp.tools.evidence import AddEvidenceInput, add_evidence

    sheet = {"kind": "verification_sheet", "items": [{"name": "x", "verdict": "n_a"}]}
    with patch("sprintable_mcp.tools.evidence.client") as mock_client:
        mock_client.post = AsyncMock(return_value={"id": "ev-3"})
        await add_evidence(AddEvidenceInput(
            work_item_id="task-1", work_item_type="task", type="report", ref="검증",
            source="agent", note="비고", artifact_id="artifact-1", payload=sheet,
        ))

    mock_client.post.assert_awaited_once_with(
        "/api/v2/evidence",
        json={
            "work_item_id": "task-1", "work_item_type": "task", "type": "report", "ref": "검증",
            "source": "agent", "note": "비고", "artifact_id": "artifact-1", "payload": sheet,
        },
    )


@pytest.mark.anyio
async def test_add_evidence_payload_validation_error_surfaces_as_err_not_crash():
    """REST의 EVIDENCE_PAYLOAD_INVALID(422) 등 서버 검증 실패가 이 도구를
    크래시시키지 않고 Error: 접두 텍스트로 정직하게 보고된다(REST가 SSOT —
    이 함수가 검증을 재구현/선점하지 않는다는 증거)."""
    from sprintable_mcp.tools.evidence import AddEvidenceInput, add_evidence

    with patch("sprintable_mcp.tools.evidence.client") as mock_client:
        mock_client.post = AsyncMock(side_effect=RuntimeError("HTTP 422: EVIDENCE_PAYLOAD_INVALID"))
        out = await add_evidence(AddEvidenceInput(
            work_item_id="story-1", work_item_type="story", type="report", ref="x",
            payload={"kind": "verification_sheet", "items": "not-a-list"},
        ))

    assert out[0].text.startswith("Error:")
    assert "EVIDENCE_PAYLOAD_INVALID" in out[0].text
