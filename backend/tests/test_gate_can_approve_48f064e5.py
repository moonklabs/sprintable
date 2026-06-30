"""48f064e5: doc 결재 게이트 BE-level can_approve 강제(룰 A·PO 결정).

doc-gate transition(approve/reject)은 **human + 대상 doc project has_project_access + not-author**
(resolver≠neutral_facts.requested_by_member_id)만 허용. 비-human/no-project-access/self → 403 fail-closed.
FE 게이팅은 가시성뿐이고 실 authz는 BE. SoD 가드가 parallel 경로에만 있어 plain doc-gate 는 미적용이던 갭을 닫는다.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.routers import gates as gates_mod
from app.routers.gates import (
    GateCreateRequest,
    GateTransitionRequest,
    create_gate_endpoint,
    transition_gate_endpoint,
)
from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _human(mid: uuid.UUID) -> ResolvedMember:
    return ResolvedMember(
        id=mid, user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=uuid.uuid4()
    )


def _result(obj):
    r = MagicMock()
    r.scalar_one_or_none.return_value = obj
    return r


def _doc_gate(requester_id: uuid.UUID):
    return SimpleNamespace(
        gate_type="doc_approval",
        neutral_facts={"requested_by_member_id": str(requester_id)},
        work_item_id=uuid.uuid4(),
    )


async def _call(resolved, *, execute_results, has_access=None, status="approved"):
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=execute_results)
    transition = AsyncMock(return_value=SimpleNamespace())
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    patches = [
        patch.object(gates_mod, "resolve_member", AsyncMock(return_value=resolved)),
        patch.object(gates_mod, "transition_gate", transition),
        patch.object(gates_mod.GateResponse, "model_validate", lambda g: "OK"),
    ]
    if has_access is not None:
        patches.append(patch.object(gates_mod, "has_project_access", AsyncMock(return_value=has_access)))
    import contextlib
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        result = await transition_gate_endpoint(
            id=uuid.uuid4(), body=GateTransitionRequest(status=status),
            session=session, org_id=uuid.uuid4(), auth=auth,
        )
    return result, transition


# ── ① self-approval(SoD): 상신자 본인 → 403 (doc 로드 前 차단·transition 미호출) ──
@pytest.mark.anyio
async def test_doc_gate_self_approval_forbidden():
    mid = uuid.uuid4()
    gate = _doc_gate(requester_id=mid)  # requester == approver
    transition = AsyncMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result(gate)])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_human(mid))), \
         patch.object(gates_mod, "transition_gate", transition):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=session, org_id=uuid.uuid4(), auth=auth,
            )
    assert ei.value.status_code == 403
    transition.assert_not_awaited()


# ── ①' fail-closed: 상신자 미기록(None) → 403 (silent self-approval 우회 방지·산티아고/PO 플래그) ──
@pytest.mark.anyio
async def test_doc_gate_missing_requester_fail_closed():
    gate = SimpleNamespace(gate_type="doc_approval", neutral_facts={}, work_item_id=uuid.uuid4())
    transition = AsyncMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result(gate)])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_human(uuid.uuid4()))), \
         patch.object(gates_mod, "transition_gate", transition):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=session, org_id=uuid.uuid4(), auth=auth,
            )
    assert ei.value.status_code == 403
    transition.assert_not_awaited()


# ── ② no-project-access human → 403 ──
@pytest.mark.anyio
async def test_doc_gate_no_project_access_forbidden():
    gate = _doc_gate(requester_id=uuid.uuid4())  # 다른 상신자
    doc = SimpleNamespace(project_id=uuid.uuid4())
    transition = AsyncMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result(gate), _result(doc)])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_human(uuid.uuid4()))), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=False)), \
         patch.object(gates_mod, "transition_gate", transition):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=session, org_id=uuid.uuid4(), auth=auth,
            )
    assert ei.value.status_code == 403
    transition.assert_not_awaited()


# ── doc 부재(삭제) → 403 ──
@pytest.mark.anyio
async def test_doc_gate_deleted_doc_forbidden():
    gate = _doc_gate(requester_id=uuid.uuid4())
    transition = AsyncMock()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_result(gate), _result(None)])  # doc None
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=_human(uuid.uuid4()))), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "transition_gate", transition):
        with pytest.raises(HTTPException) as ei:
            await transition_gate_endpoint(
                id=uuid.uuid4(), body=GateTransitionRequest(status="approved"),
                session=session, org_id=uuid.uuid4(), auth=auth,
            )
    assert ei.value.status_code == 403
    transition.assert_not_awaited()


# ── ③ 자격 human(not-author·project-access) → 정상 transition ──
@pytest.mark.anyio
async def test_doc_gate_qualified_human_allowed():
    gate = _doc_gate(requester_id=uuid.uuid4())  # 다른 상신자
    doc = SimpleNamespace(project_id=uuid.uuid4())
    result, transition = await _call(
        _human(uuid.uuid4()), execute_results=[_result(gate), _result(doc)], has_access=True
    )
    assert result == "OK"
    transition.assert_awaited_once()


# ── 일반 POST /gates 로 doc_approval 직접 생성 봉인(2중) ──
# primary: GateCreateRequest validator(GATE_TYPES allow-list)가 doc_approval 거부(422·codex가 놓친 기존 차단).
def test_generic_create_request_validator_rejects_doc_approval():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        GateCreateRequest(
            work_item_id=uuid.uuid4(), work_item_type="doc", gate_type="doc_approval",
            member_id=uuid.uuid4(), role_id=uuid.uuid4(), neutral_facts={},
        )


# 방어심층: validator 우회(model_construct)해도 엔드포인트가 doc_approval 직접 생성 403(GATE_TYPES 확장 대비).
@pytest.mark.anyio
async def test_generic_endpoint_rejects_doc_approval_defense_in_depth():
    body = GateCreateRequest.model_construct(
        work_item_id=uuid.uuid4(), work_item_type="doc", gate_type="doc_approval",
        member_id=uuid.uuid4(), role_id=uuid.uuid4(),
        neutral_facts={"requested_by_member_id": str(uuid.uuid4())},
    )
    create = AsyncMock()
    with patch.object(gates_mod, "create_gate", create):
        with pytest.raises(HTTPException) as ei:
            await create_gate_endpoint(
                body=body, session=AsyncMock(), org_id=uuid.uuid4(), _auth=SimpleNamespace()
            )
    assert ei.value.status_code == 403
    create.assert_not_awaited()


# ── 비-doc 게이트(merge 등)는 새 authz 무적용(기존 경로 무변경) ──
@pytest.mark.anyio
async def test_non_doc_gate_skips_doc_authz():
    merge_gate = SimpleNamespace(gate_type="merge_approval", neutral_facts={}, work_item_id=uuid.uuid4())
    # doc-gate 분기 미진입 → has_project_access 미호출·doc 미로드. transition 정상.
    result, transition = await _call(
        _human(uuid.uuid4()), execute_results=[_result(merge_gate)], has_access=None
    )
    assert result == "OK"
    transition.assert_awaited_once()
