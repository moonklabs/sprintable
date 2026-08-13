"""story #2624 — gate_service._notify_doc_gate_requester 게이팅 로직(mock, no_db).

각 no-op 조건(비-doc-gate·비-terminal 상태·resolver_id 없음·requested_by_member_id 없음)이
DB 왕복 0으로 정확히 걸리는지 — dispatch_approval_result_reply 자체는 실PG로
test_2624_approval_result_reply.py가 검증한다."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.gate_service import _notify_doc_gate_requester


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(**overrides):
    defaults = dict(
        id=uuid.uuid4(),
        org_id=uuid.uuid4(),
        work_item_id=uuid.uuid4(),
        work_item_type="doc",
        gate_type="doc_approval",
        resolver_id=uuid.uuid4(),
        resolution_note=None,
        neutral_facts={"requested_by_member_id": str(uuid.uuid4())},
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.mark.anyio
async def test_non_doc_gate_is_noop_zero_db_calls():
    session = AsyncMock()
    gate = _gate(work_item_type="story", gate_type="merge")
    await _notify_doc_gate_requester(session, gate, "approved")
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_non_doc_approval_gate_type_is_noop():
    session = AsyncMock()
    gate = _gate(gate_type="artifact_canonicalize")
    await _notify_doc_gate_requester(session, gate, "approved")
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_non_terminal_status_is_noop():
    session = AsyncMock()
    gate = _gate()
    await _notify_doc_gate_requester(session, gate, "pending")
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_missing_resolver_id_is_noop():
    session = AsyncMock()
    gate = _gate(resolver_id=None)
    await _notify_doc_gate_requester(session, gate, "approved")
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_missing_requested_by_in_facts_is_noop():
    session = AsyncMock()
    gate = _gate(neutral_facts={})
    await _notify_doc_gate_requester(session, gate, "approved")
    session.execute.assert_not_called()


@pytest.mark.anyio
async def test_doc_not_found_is_noop_no_delivery_call():
    session = AsyncMock()
    result = AsyncMock()
    result.scalar_one_or_none = lambda: None
    session.execute = AsyncMock(return_value=result)
    gate = _gate()
    with patch("app.services.approval_delivery.dispatch_approval_result_reply", new=AsyncMock()) as mock_dispatch:
        await _notify_doc_gate_requester(session, gate, "approved")
    mock_dispatch.assert_not_awaited()


@pytest.mark.anyio
async def test_valid_gate_calls_delivery_with_correct_args():
    session = AsyncMock()
    fake_doc = SimpleNamespace(id=uuid.uuid4(), title="T")
    result = AsyncMock()
    result.scalar_one_or_none = lambda: fake_doc
    session.execute = AsyncMock(return_value=result)

    requester_id = uuid.uuid4()
    gate = _gate(neutral_facts={"requested_by_member_id": str(requester_id)}, resolution_note="사유")

    with patch("app.services.approval_delivery.dispatch_approval_result_reply", new=AsyncMock()) as mock_dispatch:
        await _notify_doc_gate_requester(session, gate, "rejected")

    mock_dispatch.assert_awaited_once()
    kw = mock_dispatch.await_args.kwargs
    assert kw["org_id"] == gate.org_id
    assert kw["doc"] is fake_doc
    assert kw["gate_id"] == gate.id
    assert kw["requester_id"] == requester_id
    assert kw["resolver_id"] == gate.resolver_id
    assert kw["decision"] == "rejected"
    assert kw["resolution_note"] == "사유"


@pytest.mark.anyio
async def test_delivery_exception_swallowed_best_effort():
    """dispatch_approval_result_reply가 터져도 게이트 해소 자체(호출부)로 예외가 새지 않는다."""
    session = AsyncMock()
    fake_doc = SimpleNamespace(id=uuid.uuid4(), title="T")
    result = AsyncMock()
    result.scalar_one_or_none = lambda: fake_doc
    session.execute = AsyncMock(return_value=result)
    gate = _gate()

    with patch(
        "app.services.approval_delivery.dispatch_approval_result_reply",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        await _notify_doc_gate_requester(session, gate, "approved")  # 예외 전파 없이 반환
