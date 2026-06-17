"""E-HITL-GATING S-GATE-5: HITL 게이트 측정 — compute(집계)·_ratio·엔드포인트(shape)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _res_all(rows):
    r = MagicMock()
    r.all.return_value = rows
    return r


def _res_scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


def _res_one(tup):
    r = MagicMock()
    r.one.return_value = tup
    return r


# ── _ratio ───────────────────────────────────────────────────────────────────


def test_ratio_semantics():
    from app.services.gate_metrics import _ratio

    assert _ratio(0, 0) is None   # denom 0 → 데이터 없음
    assert _ratio(5, 0) is None
    assert _ratio(0, 4) == 0.0    # 데이터 있고 0 → 실제 0
    assert _ratio(2, 5) == 0.4


# ── compute_hitl_gate_metrics ─────────────────────────────────────────────────


@pytest.mark.anyio
async def test_compute_full():
    from app.services.gate_metrics import compute_hitl_gate_metrics

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[
        _res_all([("pending", 2), ("approved", 5), ("rejected", 3)]),  # 볼륨
        _res_scalar(12.5),                                             # 해소시간(분)
        _res_one((5, 2, 1)),  # approved_resolved=5·rubber=2·self_approval=1
    ])
    m = await compute_hitl_gate_metrics(session, org_id=uuid.uuid4())
    assert m.ask_total == 10
    assert (m.pending, m.approved, m.rejected) == (2, 5, 3)
    assert m.prevented_bad_pass == 3            # = rejected
    assert m.ask_resolution_minutes == 12.5
    assert m.rubber_stamp_rate == 2 / 5         # rubber/approved_resolved
    assert m.self_approval_caught == 1
    assert m.coverage is None                   # 소스 한계


@pytest.mark.anyio
async def test_compute_empty():
    from app.services.gate_metrics import compute_hitl_gate_metrics

    session = MagicMock()
    session.execute = AsyncMock(side_effect=[
        _res_all([]),            # 볼륨 없음
        _res_scalar(None),       # 해소 데이터 없음
        _res_one((0, 0, 0)),     # approved_resolved 0
    ])
    m = await compute_hitl_gate_metrics(session, org_id=uuid.uuid4())
    assert m.ask_total == 0
    assert m.prevented_bad_pass == 0
    assert m.ask_resolution_minutes is None
    assert m.rubber_stamp_rate is None          # denom 0 → null(0.0 아님)
    assert m.self_approval_caught == 0


# ── 엔드포인트 shape ───────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_endpoint_shape():
    from app.routers import gate_metrics as gm
    from app.services.gate_metrics import HitlGateMetrics

    pid = uuid.uuid4()
    with patch(
        "app.routers.gate_metrics.compute_hitl_gate_metrics",
        new=AsyncMock(return_value=HitlGateMetrics(
            ask_total=4, pending=1, approved=2, rejected=1, prevented_bad_pass=1,
            ask_resolution_minutes=8.0, rubber_stamp_rate=0.5, self_approval_caught=0, coverage=None,
        )),
    ):
        out = await gm.get_hitl_gate_metrics(
            project_id=pid, start=None, end=None,
            session=MagicMock(), org_id=uuid.uuid4(), _auth=MagicMock(),
        )
    assert out.ask_total == 4
    assert out.prevented_bad_pass == 1
    assert out.rubber_stamp_rate == 0.5
    assert out.project_id == str(pid)
    assert out.window == {"start": None, "end": None}
