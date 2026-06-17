"""E-HITL-GATING S-GATE-2: enforce_gate — flag-off no-op·auto·block 409·ask(park/resume)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


def _session(execute_side_effect=None):
    s = MagicMock()
    s.execute = AsyncMock(side_effect=execute_side_effect or [])
    s.add = MagicMock()
    s.commit = AsyncMock()
    s.refresh = AsyncMock()
    return s


async def _enforce(ge, session, level=None, active=True):
    return await ge.enforce_gate(
        session, org_id=uuid.uuid4(), project_id=uuid.uuid4(),
        work_type="done", actor_type="agent", actor_id=uuid.uuid4(),
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
    session.add.assert_not_called()


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

    # approved 조회 None → pending 조회 None → 신규 생성
    session = _session(execute_side_effect=[_scalar(None), _scalar(None)])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_ASK"
    assert ei.value.detail["requires_human"] is True
    session.add.assert_called_once()  # HitlRequest 생성
    session.commit.assert_awaited()   # raise 전 persist


@pytest.mark.anyio
async def test_ask_resumes_on_approved():
    from app.services import gate_enforce as ge

    # approved 조회 → 승인된 request id → 통과(재시도 통과·A)
    session = _session(execute_side_effect=[_scalar(uuid.uuid4())])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        await _enforce(ge, session)  # 예외 없음
    session.add.assert_not_called()  # 승인 있으면 신규 생성 안 함


@pytest.mark.anyio
async def test_ask_existing_pending_no_dup_409():
    from fastapi import HTTPException

    from app.services import gate_enforce as ge

    # approved None → pending 존재 → 중복 생성 안 함·409
    session = _session(execute_side_effect=[_scalar(None), _scalar(uuid.uuid4())])
    with patch.object(ge, "gate_config_enforce_active", return_value=True), patch.object(
        ge, "resolve_gate_level", new=AsyncMock(return_value="ask")
    ):
        with pytest.raises(HTTPException) as ei:
            await _enforce(ge, session)
    assert ei.value.status_code == 409
    assert ei.value.detail["code"] == "GATE_ASK"
    session.add.assert_not_called()  # 기존 pending 재사용


# ── gate_config_enforce_active flag ──────────────────────────────────────────


def test_enforce_active_flag_off_default():
    from app.services.gate_enforce import gate_config_enforce_active

    # default settings(enabled=False) → 항상 False
    assert gate_config_enforce_active(uuid.uuid4()) is False
