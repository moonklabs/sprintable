"""48f064e5: doc 결재 → 인앱 Gate inbox 와이어.

상신(draft→pending)=doc-gate(work_item_type='doc'·pending) 생성→Gate inbox 노출(AC1)·gate approve→
confirmed/reject→denied(AC2)·pending status 추가로 422 해소(AC3)·human-only 결재=게이트 엔드포인트 authz(AC4).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.doc import (
    DOC_GATE_TYPE,
    DOC_GATE_WORK_ITEM_TYPE,
    DocTransitionError,
    transition_doc,
)
from app.services.gate_service import _resolve_doc_gate
from app.services.member_resolver import ResolvedMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _human(org):
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="u", type="human",
                          role="member", org_id=org)


def _doc_session(doc):
    result = MagicMock()
    result.scalar_one_or_none.return_value = doc
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    return session


# ─── AC1: 상신 → doc-gate 생성·Gate inbox ────────────────────────────────────

@pytest.mark.anyio
async def test_submit_creates_doc_gate_and_pending_status():
    org = uuid.uuid4()
    doc = MagicMock(status="draft", id=uuid.uuid4(), title="설계 문서", project_id=uuid.uuid4())
    session = _doc_session(doc)
    role_id = uuid.uuid4()
    with patch("app.services.gate_service.create_gate",
               new=AsyncMock(return_value=MagicMock(status="pending"))) as mock_cg, \
         patch("app.services.workflow_line_config._default_role_id",
               new=AsyncMock(return_value=role_id)):
        caller = _human(org)
        out = await transition_doc(session, org, caller, doc.id, "pending")
    assert out.status == "pending"  # 결재 대기
    # doc-gate(work_item_type='doc'·gate_type='doc_approval') 생성 → /api/gates?status=pending 노출
    args = mock_cg.await_args.args
    assert args[2] == doc.id and args[3] == DOC_GATE_WORK_ITEM_TYPE and args[4] == DOC_GATE_TYPE
    assert args[5] == caller.id  # 상신자 = member_id


# ─── BLOCKER fix: 상신서 requested_by_member_id 항상 caller.id server-stamp(forged 덮어쓰기) ───

@pytest.mark.anyio
async def test_submit_server_stamps_requester_over_forged_pending_gate():
    """일반 gate 엔드포인트로 forged requested_by_member_id 의 pending doc_approval gate 가 pre-create 돼도,
    상신(transition_doc)이 create_gate 멱등 재사용 gate 의 requested_by_member_id 를 **caller.id 로 덮어씀**
    (client-forged 불신·self-approval 가드가 신뢰하는 requester 가 위조 불가)."""
    org = uuid.uuid4()
    doc = MagicMock(status="draft", id=uuid.uuid4(), title="설계", project_id=uuid.uuid4())
    session = _doc_session(doc)
    forged = uuid.uuid4()
    # create_gate 멱등이 반환하는 **기존 forged pending gate**(requester=타인).
    gate = SimpleNamespace(id=uuid.uuid4(), status="pending",
                           neutral_facts={"requested_by_member_id": str(forged)})
    with patch("app.services.gate_service.create_gate", new=AsyncMock(return_value=gate)), \
         patch("app.services.workflow_line_config._default_role_id",
               new=AsyncMock(return_value=uuid.uuid4())):
        caller = _human(org)
        await transition_doc(session, org, caller, doc.id, "pending")
    # forged 가 caller.id 로 server-stamp 됨(우회 봉).
    assert gate.neutral_facts["requested_by_member_id"] == str(caller.id)
    assert gate.neutral_facts["requested_by_member_id"] != str(forged)


# ─── AC2: gate 해소 → doc status ─────────────────────────────────────────────

def _doc_gate(work_item_id):
    return MagicMock(work_item_type=DOC_GATE_WORK_ITEM_TYPE, gate_type=DOC_GATE_TYPE,
                     work_item_id=work_item_id, org_id=uuid.uuid4())


def _gate_session(doc):
    """_resolve_doc_gate 는 select(Doc)(org_id+deleted_at 가드)로 조회 — execute 모킹."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = doc
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    session.flush = AsyncMock()
    return session


@pytest.mark.anyio
async def test_gate_approve_confirms_doc():
    doc = MagicMock(status="pending")
    await _resolve_doc_gate(_gate_session(doc), _doc_gate(uuid.uuid4()), "approved")
    assert doc.status == "confirmed"


@pytest.mark.anyio
async def test_gate_reject_denies_doc():
    doc = MagicMock(status="pending")
    await _resolve_doc_gate(_gate_session(doc), _doc_gate(uuid.uuid4()), "rejected")
    assert doc.status == "denied"


@pytest.mark.anyio
async def test_gate_resolve_noop_when_not_pending():
    """이미 결정/취소(non-pending) doc → no-op(멱등·double-resolve 방어)."""
    doc = MagicMock(status="confirmed")
    await _resolve_doc_gate(_gate_session(doc), _doc_gate(uuid.uuid4()), "approved")
    assert doc.status == "confirmed"  # 불변


@pytest.mark.anyio
async def test_gate_resolve_ignores_non_doc_gate():
    """story/merge 게이트엔 무영향(work_item_type/gate_type 가드·doc 조회 0)."""
    session = AsyncMock(); session.execute = AsyncMock()
    gate = MagicMock(work_item_type="story", gate_type="merge", work_item_id=uuid.uuid4())
    await _resolve_doc_gate(session, gate, "approved")
    session.execute.assert_not_called()


# ─── RC(산티아고): 재상신 시 terminal gate re-open(결재 재가능) ──────────────

@pytest.mark.anyio
async def test_resubmit_reopens_terminal_gate():
    """draft→pending→reject→denied→draft→재상신: create_gate 멱등이 기존 rejected gate 반환 →
    pending 으로 re-open(resolver/해소메타 clear) → 결재 재가능(Gate inbox 재노출)."""
    org = uuid.uuid4()
    doc = MagicMock(status="draft", id=uuid.uuid4(), title="t", project_id=uuid.uuid4())
    session = _doc_session(doc)
    prior_resolver = uuid.uuid4()
    rejected = MagicMock(status="rejected", resolver_id=prior_resolver,
                         resolved_at=datetime(2026, 6, 26, tzinfo=timezone.utc),
                         resolution_note="반려사유", neutral_facts=None)
    with patch("app.services.gate_service.create_gate", new=AsyncMock(return_value=rejected)), \
         patch("app.services.workflow_line_config._default_role_id",
               new=AsyncMock(return_value=uuid.uuid4())):
        await transition_doc(session, org, _human(org), doc.id, "pending")
    assert rejected.status == "pending"          # re-open
    assert rejected.resolver_id is None and rejected.resolved_at is None
    assert rejected.resolution_note is None
    assert doc.status == "pending"
    # 감사추적 보존(산티아고): 이전 반려(누가/왜)가 decision_history 에 append.
    hist = rejected.neutral_facts["decision_history"]
    assert hist[-1]["status"] == "rejected" and hist[-1]["resolution_note"] == "반려사유"
    assert hist[-1]["resolver_id"] == str(prior_resolver)


# ─── AC3: pending 직접 self-confirm 차단(gate 해소로만) ───────────────────────

@pytest.mark.anyio
async def test_pending_direct_confirm_blocked_without_gate():
    org = uuid.uuid4()
    doc = MagicMock(status="pending", id=uuid.uuid4(), title="t", project_id=uuid.uuid4())
    session = _doc_session(doc)
    with pytest.raises(DocTransitionError) as ei:
        await transition_doc(session, org, _human(org), doc.id, "confirmed")  # via_gate=False
    assert ei.value.code == "GATE_REQUIRED"


# ─── 500 fix: 전이 엔드포인트가 commit 後 refresh (MissingGreenlet 방지) ─────────

def test_transition_endpoint_refreshes_before_serialize():
    """UPDATE→commit으로 server-onupdate(updated_at) expired → model_validate lazy-load=MissingGreenlet
    →500. commit→refresh→model_validate 순서로 async 컨텍스트 eager 재로드(라이브 dev 재현됨)."""
    import inspect
    from app.routers import docs
    src = inspect.getsource(docs.transition_doc_endpoint)
    assert "await session.refresh(doc)" in src
    i_commit = src.index("await session.commit()")
    i_refresh = src.index("await session.refresh(doc)")
    i_validate = src.rindex("DocResponse.model_validate(doc)")
    assert i_commit < i_refresh < i_validate  # 순서 정합


# ─── doc-gate v2: 갭1 항상 manual(auto_pass 제외) + 갭2 상신 알림 ──────────────

@pytest.mark.anyio
async def test_doc_approval_always_pending_despite_allow_auto():
    """갭1: org posture→allow_auto 여도 doc_approval 은 항상 pending(deliberate 인간 결재)."""
    from app.services.gate_service import create_gate
    captured = {}
    session = AsyncMock()
    session.add = MagicMock(side_effect=lambda g: captured.__setitem__("gate", g))
    session.flush = AsyncMock(); session.refresh = AsyncMock()
    no_existing = MagicMock(); no_existing.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_existing)
    with patch("app.services.gate_service.resolve_disposition", new=AsyncMock(return_value="allow_auto")):
        await create_gate(session, uuid.uuid4(), uuid.uuid4(), "doc", "doc_approval",
                          uuid.uuid4(), uuid.uuid4())
    assert captured["gate"].status == "pending"  # allow_auto → 그래도 pending(force)


@pytest.mark.anyio
async def test_non_doc_gate_still_auto_passes():
    """비-doc 게이트(merge 등)는 기존대로 allow_auto→auto_passed(force 미적용·무회귀)."""
    from app.services.gate_service import create_gate
    captured = {}
    session = AsyncMock()
    session.add = MagicMock(side_effect=lambda g: captured.__setitem__("gate", g))
    session.flush = AsyncMock(); session.refresh = AsyncMock()
    no_existing = MagicMock(); no_existing.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=no_existing)
    with patch("app.services.gate_service.resolve_disposition", new=AsyncMock(return_value="allow_auto")):
        await create_gate(session, uuid.uuid4(), uuid.uuid4(), "story", "merge",
                          uuid.uuid4(), uuid.uuid4())
    assert captured["gate"].status == "auto_passed"


@pytest.mark.anyio
async def test_submit_notifies_org_approvers():
    """갭2: 상신 → org owner/admin 휴먼 결재자에게 dispatch_notification(상신자 제외·gate 참조)."""
    from app.services.doc import _notify_doc_approval_requested
    org, requester, gate_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    doc = MagicMock(id=uuid.uuid4(), title="설계 문서", project_id=uuid.uuid4())
    owners = [uuid.uuid4(), uuid.uuid4()]
    res = MagicMock(); res.scalars.return_value.all.return_value = owners
    session = AsyncMock(); session.execute = AsyncMock(return_value=res)
    with patch("app.services.notification_dispatch.dispatch_notification", new=AsyncMock()) as dn:
        await _notify_doc_approval_requested(session, org, doc, gate_id, requester_id=requester)
    dn.assert_awaited_once()
    kw = dn.await_args.kwargs
    assert kw["target_member_ids"] == owners
    assert kw["event_type"] == "doc_approval_requested"
    assert kw["reference_type"] == "gate" and kw["reference_id"] == gate_id
    # 산티아고 RC: approver 쿼리에 deleted_at 필터(삭제 owner/admin 제외).
    assert "deleted_at" in str(session.execute.await_args.args[0])


@pytest.mark.anyio
async def test_submit_notify_fail_silent():
    """알림 실패는 상신 비중단(예외 전파 0)."""
    from app.services.doc import _notify_doc_approval_requested
    session = AsyncMock(); session.execute = AsyncMock(side_effect=RuntimeError("boom"))
    await _notify_doc_approval_requested(session, uuid.uuid4(), MagicMock(id=uuid.uuid4()),
                                         uuid.uuid4(), requester_id=uuid.uuid4())
