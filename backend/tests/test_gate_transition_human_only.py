"""authz 93fc7aeb: 게이트 transition(approve/reject)는 휴먼 member만.

에이전트(API key)가 merge 게이트를 승인하면 "agent-assisted·human-validated" 웨지 전제가 무너진다.
엔드포인트에서 resolve_member.type!="human"이면 403으로 차단(transition_gate 서비스/system
auto-resolution은 불변).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers import gates as gates_mod
from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _resolved(member_type: str) -> ResolvedMember:
    return ResolvedMember(
        id=uuid.uuid4(), user_id=(uuid.uuid4() if member_type == "human" else None),
        name="m", type=member_type, role="member", org_id=uuid.uuid4(),
    )


async def _call(status: str, member_type: str):
    org_id = uuid.uuid4()
    body = GateTransitionRequest(status=status, resolver_id=uuid.uuid4())
    session = AsyncMock()
    # 48f064e5: 엔드포인트가 doc-gate authz용 게이트 로드 → 비-doc 게이트 반환(merge 등)으로 그 분기 skip.
    _gr = MagicMock()
    _gr.scalar_one_or_none.return_value = SimpleNamespace(gate_type="merge_approval")
    session.execute = AsyncMock(return_value=_gr)
    transition = AsyncMock(return_value=SimpleNamespace())
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(member_type))), \
         patch.object(gates_mod, "transition_gate", transition), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        result = await transition_gate_endpoint(
            id=uuid.uuid4(), body=body, session=session, org_id=org_id, auth=SimpleNamespace(),
        )
    return result, transition


# ── AC①④: 에이전트 approve/reject → 403 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_agent_approve_forbidden():
    with pytest.raises(HTTPException) as ei:
        await _call("approved", "agent")
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_agent_reject_forbidden():
    with pytest.raises(HTTPException) as ei:
        await _call("rejected", "agent")
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_agent_approve_does_not_call_transition():
    # 403 차단이 transition_gate 호출 前(상태 변경 0).
    transition = AsyncMock()
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved("agent"))), \
         patch.object(gates_mod, "transition_gate", transition):
        with pytest.raises(HTTPException):
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=AsyncMock(), org_id=uuid.uuid4(), auth=SimpleNamespace(),
            )
    transition.assert_not_awaited()


# ── AC③: 휴먼 approve/reject 정상 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_human_approve_allowed():
    result, transition = await _call("approved", "human")
    assert result == "OK"
    transition.assert_awaited_once()


@pytest.mark.anyio
async def test_human_reject_allowed():
    result, transition = await _call("rejected", "human")
    assert result == "OK"
    transition.assert_awaited_once()
