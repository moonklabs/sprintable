"""E-HITL-GATING S-GATE-2: enforce_gate — flag-off no-op·auto·block·ask(park/resume/reject/dedup)·
fail-closed(actor_type 불명 시 더 restrictive·QA HIGH②)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _first(val):
    """ask 분기 단일 쿼리 — result.first() 가 (id, status) 또는 None 반환."""
    r = MagicMock()
    r.first.return_value = val
    return r


def _session(execute_side_effect=None):
    s = MagicMock()
    s.execute = AsyncMock(side_effect=execute_side_effect or [])
    s.add = MagicMock()
    s.commit = AsyncMock()
    s.refresh = AsyncMock()
    return s


def _hitl_reqs_added(session):
    """S-GATE-5.1 후 session.add 는 HitlGateAudit 도 받으므로 — HitlRequest park 만 카운트."""
    from app.models.hitl import HitlRequest

    return sum(1 for c in session.add.call_args_list if isinstance(c.args[0], HitlRequest))


async def _enforce(ge, session, actor_type="agent", work_type="done"):
    return await ge.enforce_gate(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        work_type=work_type, actor_type=actor_type, actor_id=uuid.uuid4(),
        work_item_id=uuid.uuid4(), work_item_title="X",
    )


@pytest.mark.anyio
async def test_flag_off_noop():
    from app.services import gate_enforce as ge

    session = _session()
    with patch.object(ge, "gate_config_enforce_active", return_value=False), patch.object(
        ge, "resolve_gate_level", new=AsyncMock()
    ) as rgl:
        await _enforce(ge, session)
    rgl.assert_not_awaited()  # 비활성 → resolve 호출도 안 함


@pytest.mark.anyio
async def test_auto_passes():
    from app.services import gate_enforce as ge

    session = _session()
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="auto")
    ):
        await _enforce(ge, session)  # 예외 없음
    assert _hitl_reqs_added(session) == 0


@pytest.mark.anyio
async def test_block_409():
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    session = _session()
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="block")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_BLOCKED"


@pytest.mark.anyio
async def test_ask_creates_request_and_409():
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    # 결정 이력 없음(first→None) → 신규 pending 생성
    session = _session(execute_side_effect=[_first(None)])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_ASK"
    assert ei.value.detail["requires_human"] is True
    assert _hitl_reqs_added(session) == 1  # HitlRequest 생성
    session.commit.assert_awaited()   # raise 전 persist


@pytest.mark.anyio
async def test_ask_resumes_on_approved():
    from app.services import gate_enforce as ge

    # 최신 결정 = approved·승인자≠요청자 → 통과(재시도 통과·§6-2 A)
    # row = (id, status, responded_by, orig_actor_id)
    session = _session(execute_side_effect=[
        _first((uuid.uuid4(), "approved", uuid.uuid4(), uuid.uuid4()))
    ])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        await _enforce(ge, session)  # 예외 없음
    assert _hitl_reqs_added(session) == 0  # 승인 있으면 신규 생성 안 함


@pytest.mark.anyio
async def test_ask_rejected_remains_blocked():
    """QA HIGH①: 최신 결정 = rejected → 409 GATE_REJECTED·재-ask(신규 pending) 금지."""
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    session = _session(execute_side_effect=[_first((uuid.uuid4(), "rejected", None, None))])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_REJECTED"
    assert _hitl_reqs_added(session) == 0  # reject → 재-ask 안 함(차단 유지)


@pytest.mark.anyio
async def test_ask_existing_pending_no_dup_409():
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    # 최신 결정 = pending → 중복 생성 안 함·기존 request_id 로 409
    session = _session(execute_side_effect=[_first((uuid.uuid4(), "pending", None, None))])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_ASK"
    assert _hitl_reqs_added(session) == 0  # 기존 pending 재사용


# ── HIGH②: fail-closed (actor_type 불명) ──────────────────────────────────────


@pytest.mark.anyio
async def test_failclosed_unknown_actor_uses_most_restrictive():
    """actor_type None → None→human 묵시 금지. 두 actor config 중 더 restrictive 적용."""
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    session = _session()
    # ACTOR_TYPES 순회 2회: agent=auto, human=block → 더 restrictive=block → 409 BLOCKED
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(side_effect=["auto", "block"])
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session, actor_type=None)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_BLOCKED"


@pytest.mark.anyio
async def test_failclosed_known_actor_single_resolve():
    """알려진 actor(agent)는 단일 resolve — 불필요한 양쪽 조회 안 함."""
    from app.services import gate_enforce as ge

    session = _session()
    rgl = AsyncMock(return_value="auto")
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=rgl
    ):
        await _enforce(ge, session, actor_type="agent")
    assert rgl.await_count == 1  # 알려진 actor → 1회만


# ── S-GATE-3: 안전 하한(floor clamp) + self-approval 차단 ──────────────────────


@pytest.mark.anyio
async def test_floor_clamp_merge_auto_becomes_ask():
    """§3d ②③: merge floor=ask — config auto여도 auto로 못 내림. auto→ask→park."""
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    # merge·config=auto 이지만 floor=ask → ask 분기(이력 없음→park)
    session = _session(execute_side_effect=[_first(None)])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="auto")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session, work_type="merge")
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_ASK"  # auto 였지만 floor가 ask로 끌어올림
    assert _hitl_reqs_added(session) == 1


def test_clamp_to_floor_unit():
    """floor clamp 단위 — merge: auto/ask→ask·block 유지. done: 하한 없음."""
    from app.services.gate_enforce import _clamp_to_floor

    assert _clamp_to_floor("auto", "merge") == "ask"
    assert _clamp_to_floor("ask", "merge") == "ask"
    assert _clamp_to_floor("block", "merge") == "block"  # 더 restrictive 유지
    assert _clamp_to_floor("auto", "done") == "auto"  # done 하한 없음


@pytest.mark.anyio
async def test_self_approval_blocked():
    """§3d ①: 승인자(responded_by)==원 트리거 actor(metadata.actor_id) → 409 GATE_SELF_APPROVAL."""
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    same = uuid.uuid4()
    # approved 인데 responded_by == orig_actor_id → self-approval
    session = _session(execute_side_effect=[_first((uuid.uuid4(), "approved", same, same))])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_SELF_APPROVAL"
    assert _hitl_reqs_added(session) == 0  # self-approval → 통과 안 함·재park도 안 함


# ── gate_config_enforce_active flag ──────────────────────────────────────────


def test_enforce_active_flag_off_default():
    from app.services.gate_enforce import gate_config_enforce_active

    # default settings(enabled=False) → 항상 False
    assert gate_config_enforce_active(uuid.uuid4()) is False
