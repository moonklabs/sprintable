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
from fastapi import BackgroundTasks, HTTPException

from app.routers import gates as gates_mod
from app.routers.gates import GateTransitionRequest, transition_gate_endpoint
from app.services.member_resolver import ResolvedMember
from tests.gate_mock_factory import make_gate


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
    # story #2027: note+evidence_viewed 동봉 — 이 테스트는 휴먼/에이전트 authz만 검증(risk_grade
    # 무관). 둘 다 없으면 gate_type="merge_approval"이 risk 매트릭스 두 세트 어디에도 없어 폴백
    # (보수적 고위험)으로 떨어져 approve 가 새 사유-강제 가드(AC1/AC2)에 걸린다 — 이 파일의
    # 관심사가 아니므로 둘 다 채워 그 분기를 우회한다.
    body = GateTransitionRequest(status=status, resolver_id=uuid.uuid4(), note="테스트 사유", evidence_viewed=True)
    session = AsyncMock()
    # 48f064e5: 엔드포인트가 doc-gate authz용 게이트 로드 → 비-doc 게이트 반환(merge 등)으로 그 분기 skip.
    # #2198: non-doc 분기가 work_item_type/work_item_id 를 읽으므로 SimpleNamespace 에 명시(누락
    # 시 AttributeError) — 이 테스트는 human-vs-agent authz만 검증하므로 project-role 판정
    # (_non_doc_gate_approvable) 은 아래에서 직접 patch 해 True 로 고정(그 판정 자체는 이 파일의
    # 관심사가 아님 — project-role 축은 test_2198_*_realdb.py 가 별도로 커버).
    _gr = MagicMock()
    _gr.scalar_one_or_none.return_value = make_gate(
        gate_type="merge_approval", work_item_type="story", work_item_id=uuid.uuid4(),
    )
    session.execute = AsyncMock(return_value=_gr)
    # story #2813: 엔드포인트가 commit 前 gate.gate_type 을 읽어 merge 게이트인지 판정하고(anchor
    # 기록 여부), commit 後 publish_gate_check 배경 태스크 예약에 gate.id 를 읽는다(태스크 자체는
    # 이 테스트에서 실행 안 됨 — BackgroundTasks().add_task 는 큐잉만). gate_type을 "merge"가 아닌
    # 값으로 둬 anchor 기록 분기(resolve_pr_link 추가 조회)를 건너뛴다 — 이 파일의 관심사(human-vs-
    # agent authz)와 무관.
    transition = AsyncMock(return_value=make_gate(gate_type="merge_approval", neutral_facts=None))
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_resolved(member_type))), \
         patch.object(gates_mod, "transition_gate", transition), \
         patch.object(gates_mod, "_non_doc_gate_approvable", AsyncMock(return_value=True)), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"):
        result = await transition_gate_endpoint(
            id=uuid.uuid4(), body=body, background_tasks=BackgroundTasks(),
            session=session, org_id=org_id, auth=SimpleNamespace(user_id=str(uuid.uuid4())),
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
                background_tasks=BackgroundTasks(),
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
