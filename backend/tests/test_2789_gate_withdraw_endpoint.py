"""story #2789 — 갭③: 요청자(에이전트 포함) 자기 결정 카드 철회 API.

`/void`(admin-only)와 다른 인가 축(본인이 원 요청자인가만 검사, neutral_facts.
requested_by_member_id 매치) — test_edg_s30_void_recovery.py의 엔드포인트 직접호출
unit 패턴(session/resolve_member/void_gate 전부 mock)을 그대로 재사용한다. void_gate
자체의 상태전이/audit 로직은 test_edg_s30이 이미 커버(SSOT 재사용·새 상태기계 0).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException


def _resolved(member_id):
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=member_id, user_id=uuid.uuid4(), name="caller",
                          type="human", role="member", org_id=uuid.uuid4())


def _fake_gate(*, requester_id, designated_approver_id=None, status="pending"):
    return SimpleNamespace(
        id=uuid.uuid4(), org_id=uuid.uuid4(), status=status,
        work_item_type="agent_decision", work_item_id=uuid.uuid4(),
        designated_approver_id=designated_approver_id,
        neutral_facts={
            "requested_by_member_id": str(requester_id),
            "question": "A or B?",
            "project_id": str(uuid.uuid4()),
        },
    )


def _session_returning(gate):
    """session.execute(select(Gate)...) → .scalar_one_or_none() == gate 로 고정한 AsyncMock."""
    session = AsyncMock()
    session.execute = AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: gate))
    return session


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_withdraw_endpoint_requester_can_withdraw_own_gate():
    """본인이 낸 gate → void_gate 호출·응답 반환(200 상당, 예외 없음)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id)
    voided_gate = SimpleNamespace(**{**gate.__dict__, "status": "voided"})
    voidfn = AsyncMock(return_value=voided_gate)
    session = _session_returning(gate)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: g):
        result = await withdraw_gate_endpoint(
            id=gate.id, body=GateVoidRequest(reason="더 이상 필요 없음"),
            session=session, org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
        )

    voidfn.assert_awaited_once()
    assert result.status == "voided"
    session.commit.assert_awaited()


@pytest.mark.anyio
async def test_withdraw_endpoint_non_requester_404():
    """요청자가 아닌 caller(admin 포함) → 404·void_gate 미호출(존재 비노출)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    other_requester = uuid.uuid4()
    gate = _fake_gate(requester_id=other_requester)
    voidfn = AsyncMock()
    session = _session_returning(gate)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await withdraw_gate_endpoint(
                id=gate.id, body=GateVoidRequest(reason="x"),
                session=session, org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
            )

    assert ei.value.status_code == 404
    voidfn.assert_not_awaited()


@pytest.mark.anyio
async def test_withdraw_endpoint_missing_requester_field_404():
    """neutral_facts 에 requested_by_member_id 자체가 없는(비정상/구형) gate → fail-closed 404."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id)
    gate.neutral_facts = {"question": "no requester field"}
    voidfn = AsyncMock()
    session = _session_returning(gate)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await withdraw_gate_endpoint(
                id=gate.id, body=GateVoidRequest(reason="x"),
                session=session, org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
            )

    assert ei.value.status_code == 404
    voidfn.assert_not_awaited()


@pytest.mark.anyio
async def test_withdraw_endpoint_gate_not_found_404():
    """org_id/id 로 gate 자체가 안 잡히면(다른 org 또는 오탈자 id) 404."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    voidfn = AsyncMock()
    session = _session_returning(None)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await withdraw_gate_endpoint(
                id=uuid.uuid4(), body=GateVoidRequest(reason="x"),
                session=session, org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
            )

    assert ei.value.status_code == 404
    voidfn.assert_not_awaited()


@pytest.mark.anyio
async def test_withdraw_endpoint_already_resolved_gate_422():
    """void_gate 가 불법 전이(ValueError)를 내면 422로 변환(이미 approved/rejected/voided)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id, status="approved")
    voidfn = AsyncMock(side_effect=ValueError("불법 전이: approved → voided. pending 게이트만 무효화 가능."))
    session = _session_returning(gate)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await withdraw_gate_endpoint(
                id=gate.id, body=GateVoidRequest(reason="x"),
                session=session, org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
            )

    assert ei.value.status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("is_api_key,expected_actor_type", [(True, "agent"), (False, "human")])
async def test_withdraw_endpoint_actor_type_reflects_real_caller(is_api_key, expected_actor_type):
    """⭐actor_type 하드코딩 landmine 회귀가드 — api_key_id 유무로 agent/human 정직 전달(#2789)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id)
    voidfn = AsyncMock(return_value=gate)
    session = _session_returning(gate)
    claims = {"app_metadata": {"api_key_id": "k1"}} if is_api_key else {}

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: g):
        await withdraw_gate_endpoint(
            id=gate.id, body=GateVoidRequest(reason="x"),
            session=session, org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(caller.user_id), claims=claims),
        )

    assert voidfn.call_args.kwargs["actor_type"] == expected_actor_type


@pytest.mark.anyio
async def test_withdraw_endpoint_notifies_designated_approver_as_withdrawn():
    """designated_approver 있으면 dispatch_approval_result_reply(decision='withdrawn') 호출."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    approver_id = uuid.uuid4()
    gate = _fake_gate(requester_id=caller.id, designated_approver_id=approver_id)
    voided_gate = SimpleNamespace(**{**gate.__dict__, "status": "voided"})
    voidfn = AsyncMock(return_value=voided_gate)
    session = _session_returning(gate)
    dispatch = AsyncMock()

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: g), \
         patch("app.services.approval_delivery.dispatch_approval_result_reply", dispatch):
        await withdraw_gate_endpoint(
            id=gate.id, body=GateVoidRequest(reason="더 이상 필요 없음"),
            session=session, org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
        )

    dispatch.assert_awaited_once()
    assert dispatch.call_args.kwargs["decision"] == "withdrawn"
    assert dispatch.call_args.kwargs["requester_id"] == approver_id
    assert dispatch.call_args.kwargs["resolver_id"] == caller.id


@pytest.mark.anyio
async def test_withdraw_endpoint_no_approver_skips_notification():
    """designated_approver_id 없는 gate(구형/anchor 없음) → 알림 호출 자체가 없다(에러 아님)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id, designated_approver_id=None)
    voidfn = AsyncMock(return_value=gate)
    session = _session_returning(gate)
    dispatch = AsyncMock()

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: g), \
         patch("app.services.approval_delivery.dispatch_approval_result_reply", dispatch):
        await withdraw_gate_endpoint(
            id=gate.id, body=GateVoidRequest(reason="x"),
            session=session, org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
        )

    dispatch.assert_not_awaited()


@pytest.mark.anyio
async def test_withdraw_endpoint_notification_failure_does_not_block_commit():
    """회신 배달 실패(best-effort) → 철회 자체(commit)는 그대로 완료된다."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id, designated_approver_id=uuid.uuid4())
    voidfn = AsyncMock(return_value=gate)
    session = _session_returning(gate)
    dispatch = AsyncMock(side_effect=RuntimeError("dm 라우팅 실패"))

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn), \
         patch.object(gates_mod.GateResponse, "model_validate", lambda g: g), \
         patch("app.services.approval_delivery.dispatch_approval_result_reply", dispatch):
        await withdraw_gate_endpoint(
            id=gate.id, body=GateVoidRequest(reason="x"),
            session=session, org_id=uuid.uuid4(),
            auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
        )

    session.commit.assert_awaited()


@pytest.mark.anyio
async def test_decision_label_withdrawn_is_not_mislabeled_as_rejected():
    """⭐approval_delivery._DECISION_LABELS landmine 회귀가드 — decision='withdrawn'이 이진
    fail-open 매핑(approved 아니면 전부 '반려')으로 되돌아가면 철회를 반려로 오라벨링한다."""
    from unittest.mock import AsyncMock as _AM
    from app.services import approval_delivery as ad_mod

    captured = {}

    class _FakeConv(SimpleNamespace):
        pass

    async def _fake_get_or_create(db, *, org_id, project_id, requester_id, approver_id):
        return _FakeConv(id=uuid.uuid4())

    async def _fake_dispatch_event(db, conv, msg, org_id, resolver):
        captured["content"] = msg.content

    resolver_member = SimpleNamespace(id=uuid.uuid4())

    session = AsyncMock()
    session.begin_nested = lambda: _NestedCtx()

    class _NestedCtx:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *a):
            return False

    with patch.object(ad_mod, "_get_or_create_approval_dm", _fake_get_or_create), \
         patch("app.routers.conversations._dispatch_conversation_event", _fake_dispatch_event), \
         patch("app.services.member_resolver.lookup_members_by_ids",
               _AM(return_value={resolver_member.id: resolver_member})):
        await ad_mod.dispatch_approval_result_reply(
            session, org_id=uuid.uuid4(), work_item_type="agent_decision",
            work_item_id=uuid.uuid4(), project_id=uuid.uuid4(), title="A or B?",
            gate_id=uuid.uuid4(), requester_id=uuid.uuid4(), resolver_id=resolver_member.id,
            decision="withdrawn", resolution_note=None,
            event_type="agent_decision_withdrawn",
        )

    assert "철회" in captured["content"]
    assert "반려" not in captured["content"]


# ── 카디르 QA(#3462, 2026-08-25) 회귀가드 2건 ────────────────────────────────────
def _void_gate_fixture():
    """void_gate() 내부 3개 side-effect(Gate select·step_run select·find_active_step_run_
    for_gate·ActivityLogService.record)를 전부 mock해 실PG 없이 직접호출 검증한다."""
    org_id = uuid.uuid4()
    gate_id = uuid.uuid4()
    voider_id = uuid.uuid4()
    fake_gate = SimpleNamespace(
        id=gate_id, org_id=org_id, status="pending",
        resolver_id=None, resolution_note=None, resolved_at=None,
        status_entered_at=None, gate_type="agent_decision_request",
        work_item_type="agent_decision", work_item_id=uuid.uuid4(),
        github_check_run_sha=None,
    )
    fake_sr = SimpleNamespace(
        id=uuid.uuid4(), status="gate_pending", routing_reason=None, resolved_at=None,
    )

    gate_result = SimpleNamespace(scalar_one_or_none=lambda: fake_gate)
    sr_result = SimpleNamespace(scalar_one_or_none=lambda: fake_sr)
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[gate_result, sr_result])
    return org_id, gate_id, voider_id, fake_gate, fake_sr, session


@pytest.mark.anyio
async def test_void_gate_default_preserves_original_admin_routing_reason_and_actor_type():
    """⭐회귀가드① — actor_type/void_reason_label을 분리하기 前엔 이 둘을 한 변수로 합쳐
    썼다가 기존 admin `/void` 경로의 routing_reason 리터럴이 "voided by admin"(git blame상
    항상 이 고정문구)에서 "voided by human"으로 바뀌어 test_edg_s30_void_recovery가 실PG서
    깨졌다(카디르 disposable PG 재현). 기본값(둘 다 인자 미지정)이면 byte-동일해야 한다."""
    from app.services import gate_service as gs_mod

    org_id, gate_id, voider_id, fake_gate, fake_sr, session = _void_gate_fixture()
    activity_record = AsyncMock()

    with patch(
        "app.services.workflow_line_resolution.find_active_step_run_for_gate",
        AsyncMock(return_value=fake_sr.id),
    ), patch("app.services.activity_log.ActivityLogService") as ActivityLogServiceMock:
        ActivityLogServiceMock.return_value.record = activity_record
        result = await gs_mod.void_gate(session, org_id, gate_id, voider_id, "오발행")

    assert result.status == "voided"
    assert fake_sr.routing_reason == "gate voided by admin: 오발행"
    assert activity_record.call_args.kwargs["actor_type"] == "human"


@pytest.mark.anyio
async def test_void_gate_withdraw_path_labels_requester_not_admin():
    """withdraw 호출부가 명시로 void_reason_label="requester"를 넘기면 그 표시만 바뀌고
    admin 기본값과 섞이지 않는다(두 축 분리 확인 — 라벨 축 vs actor_type 축)."""
    from app.services import gate_service as gs_mod

    org_id, gate_id, voider_id, fake_gate, fake_sr, session = _void_gate_fixture()
    activity_record = AsyncMock()

    with patch(
        "app.services.workflow_line_resolution.find_active_step_run_for_gate",
        AsyncMock(return_value=fake_sr.id),
    ), patch("app.services.activity_log.ActivityLogService") as ActivityLogServiceMock:
        ActivityLogServiceMock.return_value.record = activity_record
        await gs_mod.void_gate(
            session, org_id, gate_id, voider_id, "더 이상 필요 없음",
            actor_type="agent", void_reason_label="requester",
        )

    assert fake_sr.routing_reason == "gate voided by requester: 더 이상 필요 없음"
    assert activity_record.call_args.kwargs["actor_type"] == "agent"


@pytest.mark.anyio
async def test_withdraw_endpoint_malformed_requester_field_404_not_500():
    """⭐회귀가드② — 카디르 probe 실측: requested_by_member_id가 손상된 비-UUID 문자열이면
    uuid.UUID(...) 파싱이 uncaught ValueError→500을 낸다. 문자열비교로 바꿔 크래시 없이
    똑같이 404(모든 유효 uuid 문자열과도 매치될 리 없으므로 결과는 이미 fail-closed)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import GateVoidRequest, withdraw_gate_endpoint

    caller = _resolved(uuid.uuid4())
    gate = _fake_gate(requester_id=caller.id)
    gate.neutral_facts = {"requested_by_member_id": "not-a-valid-uuid-at-all"}
    voidfn = AsyncMock()
    session = _session_returning(gate)

    with patch.object(gates_mod, "resolve_member", AsyncMock(return_value=caller)), \
         patch.object(gates_mod, "void_gate", voidfn):
        with pytest.raises(HTTPException) as ei:
            await withdraw_gate_endpoint(
                id=gate.id, body=GateVoidRequest(reason="x"),
                session=session, org_id=uuid.uuid4(),
                auth=SimpleNamespace(user_id=str(caller.user_id), claims={}),
            )

    assert ei.value.status_code == 404
    voidfn.assert_not_awaited()
