"""89484c8c: doc-gate in-doc decider can_approve(rule A) — 헬퍼 + list_gates per-caller enrich.

`can_approve_doc_gate_reason` 단일 규칙(transition 강제와 공용·DRY)을 list_gates 가 doc_approval 게이트에
per-caller `can_approve` 로 채워 FE in-doc decider 버튼 게이팅 소스를 제공한다(admin-only·parallel-approver
전용인 `/approvers` dead-path 대체). 실 authz 는 transition BE 가 강제(이 필드=가시성뿐).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import gates as gates_mod
from app.routers.gates import can_approve_doc_gate_reason, list_gates
from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _human(mid: uuid.UUID) -> ResolvedMember:
    return ResolvedMember(
        id=mid, user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=uuid.uuid4()
    )


def _agent(mid: uuid.UUID) -> ResolvedMember:
    return ResolvedMember(
        id=mid, user_id=uuid.uuid4(), name="a", type="agent", role="member", org_id=uuid.uuid4()
    )


def _gate(requester_id, *, work_item_id=None):
    return SimpleNamespace(
        gate_type="doc_approval",
        neutral_facts={"requested_by_member_id": str(requester_id)} if requester_id else {},
        work_item_id=work_item_id or uuid.uuid4(),
        work_item_type="doc",
    )


def _doc_result(project_id):
    r = MagicMock()
    r.scalar_one_or_none.return_value = (
        SimpleNamespace(project_id=project_id) if project_id is not None else None
    )
    return r


# ────────────────────────────── 헬퍼: rule A 분기 ──────────────────────────────

@pytest.mark.anyio
async def test_reason_not_human():
    session = AsyncMock()
    reason = await can_approve_doc_gate_reason(
        session, _gate(uuid.uuid4()), _agent(uuid.uuid4()), uuid.uuid4(), uuid.uuid4(),
        doc_project_id=uuid.uuid4(),
    )
    assert reason == "not_human"
    session.execute.assert_not_awaited()  # 비-휴먼 즉시 차단(쿼리 0)


@pytest.mark.anyio
async def test_reason_self_approval():
    mid = uuid.uuid4()
    reason = await can_approve_doc_gate_reason(
        AsyncMock(), _gate(mid), _human(mid), uuid.uuid4(), uuid.uuid4(), doc_project_id=uuid.uuid4()
    )
    assert reason == "self_or_unverified"  # requester == resolver


@pytest.mark.anyio
async def test_reason_unverified_requester_fail_closed():
    reason = await can_approve_doc_gate_reason(
        AsyncMock(), _gate(None), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4(),
        doc_project_id=uuid.uuid4(),
    )
    assert reason == "self_or_unverified"  # requester 미기록 → fail-closed


@pytest.mark.anyio
async def test_reason_no_project_access_injected():
    with patch.object(gates_mod, "has_project_access", AsyncMock(return_value=False)):
        reason = await can_approve_doc_gate_reason(
            AsyncMock(), _gate(uuid.uuid4()), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4(),
            doc_project_id=uuid.uuid4(),
        )
    assert reason == "no_project_access"


@pytest.mark.anyio
async def test_reason_deleted_doc_injected_none():
    spy = AsyncMock(return_value=True)
    with patch.object(gates_mod, "has_project_access", spy):
        reason = await can_approve_doc_gate_reason(
            AsyncMock(), _gate(uuid.uuid4()), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4(),
            doc_project_id=None,  # 삭제/미존재 doc
        )
    assert reason == "no_project_access"
    spy.assert_not_awaited()  # project_id None → 접근체크 전 차단


@pytest.mark.anyio
async def test_reason_ok_injected():
    with patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)):
        reason = await can_approve_doc_gate_reason(
            AsyncMock(), _gate(uuid.uuid4()), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4(),
            doc_project_id=uuid.uuid4(),
        )
    assert reason is None  # 승인 가능(not-author + 접근 보유 + human)


@pytest.mark.anyio
async def test_reason_fetches_doc_when_project_id_unset():
    """doc_project_id 미지정(transition 단건 경로) → 대상 doc 직접 조회."""
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_doc_result(uuid.uuid4()))
    with patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)):
        reason = await can_approve_doc_gate_reason(
            session, _gate(uuid.uuid4()), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4()
        )
    assert reason is None
    session.execute.assert_awaited_once()  # _UNSET → fetch 경로


@pytest.mark.anyio
async def test_reason_fetch_deleted_doc():
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_doc_result(None))  # 조회 결과 없음(삭제)
    spy = AsyncMock(return_value=True)
    with patch.object(gates_mod, "has_project_access", spy):
        reason = await can_approve_doc_gate_reason(
            session, _gate(uuid.uuid4()), _human(uuid.uuid4()), uuid.uuid4(), uuid.uuid4()
        )
    assert reason == "no_project_access"
    spy.assert_not_awaited()


# ──────────────────── list_gates: per-caller can_approve enrich ────────────────────

def _resp(g):
    return SimpleNamespace(
        work_item_type=g.work_item_type, work_item_id=g.work_item_id,
        work_item_summary=None, can_approve=False,
    )


async def _list_gates(gate, *, has_access, resolved=None, resolve_raises=False):
    org, pid = uuid.uuid4(), uuid.uuid4()
    gates_result = MagicMock()
    gates_result.scalars.return_value.all.return_value = [gate]
    doc_batch = MagicMock()
    doc_batch.all.return_value = [(gate.work_item_id, "T", "slug", pid)]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_result, doc_batch])
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    rm = (
        AsyncMock(side_effect=Exception("boom")) if resolve_raises
        else AsyncMock(return_value=resolved or _human(uuid.uuid4()))
    )
    with patch.object(gates_mod.GateResponse, "model_validate", _resp), \
         patch.object(gates_mod, "resolve_member", rm), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=has_access)):
        return await list_gates(
            work_item_id=None, work_item_type=None, status=None,
            session=session, org_id=org, auth=auth,
        )


@pytest.mark.anyio
async def test_list_gates_can_approve_true_for_qualified():
    out = await _list_gates(_gate(uuid.uuid4()), has_access=True)  # not-author
    assert out[0].can_approve is True


@pytest.mark.anyio
async def test_list_gates_can_approve_false_no_access():
    out = await _list_gates(_gate(uuid.uuid4()), has_access=False)
    assert out[0].can_approve is False


@pytest.mark.anyio
async def test_list_gates_can_approve_false_for_author():
    mid = uuid.uuid4()
    out = await _list_gates(_gate(mid), has_access=True, resolved=_human(mid))  # author=caller
    assert out[0].can_approve is False  # self-approval 금지


@pytest.mark.anyio
async def test_list_gates_can_approve_false_for_agent():
    out = await _list_gates(_gate(uuid.uuid4()), has_access=True, resolved=_agent(uuid.uuid4()))
    assert out[0].can_approve is False  # 비-휴먼


@pytest.mark.anyio
async def test_list_gates_non_doc_gate_untouched():
    merge = SimpleNamespace(
        gate_type="merge", work_item_type="story", work_item_id=uuid.uuid4(), neutral_facts={}
    )
    org = uuid.uuid4()
    gates_result = MagicMock()
    gates_result.scalars.return_value.all.return_value = [merge]
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gates_result])  # doc_ids 비어 doc batch 미실행
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))
    rm = AsyncMock(return_value=_human(uuid.uuid4()))
    with patch.object(gates_mod.GateResponse, "model_validate", _resp), \
         patch.object(gates_mod, "resolve_member", rm), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)):
        out = await list_gates(
            work_item_id=None, work_item_type=None, status=None,
            session=session, org_id=org, auth=auth,
        )
    assert out[0].can_approve is False
    rm.assert_not_awaited()  # 비-doc 게이트만이면 resolve_member 미호출(불필요 작업 0)


@pytest.mark.anyio
async def test_list_gates_can_approve_enrich_nonfatal():
    """resolve_member 실패해도 목록은 반환(can_approve=False fail-closed·비중단)."""
    out = await _list_gates(_gate(uuid.uuid4()), has_access=True, resolve_raises=True)
    assert out[0].can_approve is False
