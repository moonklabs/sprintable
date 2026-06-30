"""b13352c2: doc 삭제 cascade — pending doc_approval 게이트 system void(orphan Gate inbox 방지).

void_pending_doc_gate: pending doc_approval gate 만 void(멱등·doc_approval 스코핑)·begin_nested 격리
best-effort(void 실패가 삭제 비중단). 삭제 권한자 트리거 system cascade라 human-gate authz 우회 정당.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.gate_service import void_pending_doc_gate


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _NestedCM:
    """real savepoint 동형: 예외 미억제(__aexit__ False) — AsyncMock 의 CM/coroutine 혼동 회피."""
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _session(gate):
    s = AsyncMock()
    gr = MagicMock()
    gr.scalar_one_or_none.return_value = gate
    s.execute = AsyncMock(return_value=gr)
    s.begin_nested = MagicMock(return_value=_NestedCM())
    return s


# ── pending doc_approval gate → void(True·사유 비어있지 않음) ──
@pytest.mark.anyio
async def test_voids_pending_doc_gate():
    gate = SimpleNamespace(id=uuid.uuid4())
    s = _session(gate)
    voider = uuid.uuid4()
    with patch("app.services.gate_service.void_gate", new=AsyncMock()) as vg:
        r = await void_pending_doc_gate(s, uuid.uuid4(), uuid.uuid4(), voider)
    assert r is True
    vg.assert_awaited_once()
    # void_gate(session, org_id, gate_id, voider_id, reason) — voider 강제·reason 비어있지 않음.
    assert vg.await_args.args[3] == voider
    assert vg.await_args.args[4].strip()


# ── pending doc-gate 없음(terminal/held/부재) → no-op(False·void 미호출·멱등) ──
@pytest.mark.anyio
async def test_noop_when_no_pending_gate():
    s = _session(None)
    with patch("app.services.gate_service.void_gate", new=AsyncMock()) as vg:
        r = await void_pending_doc_gate(s, uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
    assert r is False
    vg.assert_not_awaited()


# ── best-effort: void 실패 swallow(False·예외 비전파=삭제 비중단) ──
@pytest.mark.anyio
async def test_best_effort_swallows_void_failure():
    gate = SimpleNamespace(id=uuid.uuid4())
    s = _session(gate)
    with patch("app.services.gate_service.void_gate",
               new=AsyncMock(side_effect=ValueError("boom"))):
        r = await void_pending_doc_gate(s, uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
    assert r is False


# ── 상신취소(pending→draft)도 gate void(cancel-orphan 방지·PO 실측 ⓑ 케이스) ──
@pytest.mark.anyio
async def test_cancel_pending_to_draft_voids_gate():
    from app.services.doc import transition_doc
    from app.services.member_resolver import ResolvedMember
    org = uuid.uuid4()
    doc = MagicMock(status="pending", id=uuid.uuid4(), title="t", project_id=uuid.uuid4(), content="c")
    result = MagicMock()
    result.scalar_one_or_none.return_value = doc
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    caller = ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="u", type="human",
                            role="member", org_id=org)
    with patch("app.services.gate_service.void_pending_doc_gate",
               new=AsyncMock(return_value=True)) as vpg:
        await transition_doc(session, org, caller, doc.id, "draft")
    vpg.assert_awaited_once()
    assert vpg.await_args.args[2] == doc.id          # 그 doc 의 게이트
    assert vpg.await_args.args[3] == caller.id        # voider=취소자
    assert doc.status == "draft"
