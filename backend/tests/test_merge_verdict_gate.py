"""H1-S2: Merge verdict gate service 테스트.

decision 매트릭스(AC①~⑦) + Cage 합성(capture/trust/create_gate 재사용·AC⑥ 매 평가 gate row).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import merge_verdict_gate as mod
from app.services.merge_verdict_gate import (
    ASK_HUMAN,
    AUTO_MERGE,
    BLOCK,
    MergeGateDecision,
    _decide,
    _impl_trust,
    _normalize_result,
    evaluate_merge_gate,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── _decide 매트릭스 (AC①~⑦) ──────────────────────────────────────────────────

def _d(**over):
    base = dict(ci="pass", pr="pass", gate_status="auto_passed", trust=0.9, threshold=0.8, self_report_only=False)
    base.update(over)
    return _decide(**base)


def test_decide_ci_fail_blocks():
    assert _d(ci="fail")[0] == BLOCK  # AC①


def test_decide_ci_unknown_asks():
    assert _d(ci=None)[0] == ASK_HUMAN  # AC②
    # AC⑦: self-report만 → 사유에 명시.
    dec, reason = _d(ci=None, self_report_only=True)
    assert dec == ASK_HUMAN and "self-report" in reason


def test_decide_deny_blocks():
    assert _d(gate_status="rejected")[0] == BLOCK


def test_decide_trust_none_asks():
    assert _d(trust=None)[0] == ASK_HUMAN  # AC③


def test_decide_all_conditions_auto_merge():
    assert _d(gate_status="auto_passed", ci="pass", pr="pass", trust=0.85)[0] == AUTO_MERGE  # AC④


def test_decide_ask_posture_asks():
    assert _d(gate_status="pending")[0] == ASK_HUMAN  # AC⑤


def test_decide_trust_below_threshold_asks():
    assert _d(trust=0.5)[0] == ASK_HUMAN  # 전조건 미충족 → safe


def test_decide_pr_fail_not_auto():
    assert _d(pr="fail")[0] == ASK_HUMAN


# ── helper ─────────────────────────────────────────────────────────────────────

def test_normalize_result():
    assert _normalize_result("pass") == "pass" and _normalize_result("success") == "pass"
    assert _normalize_result("failure") == "fail" and _normalize_result(None) is None


def test_impl_trust_extracts_role_rate():
    res = {"scores": [{"role_key": "implementation", "clean_pass_rate": 0.92},
                      {"role_key": "qa", "clean_pass_rate": 0.5}]}
    assert _impl_trust(res, "implementation") == 0.92
    assert _impl_trust({"scores": []}, "implementation") is None  # verdict 없음 → None.


# ── evaluate_merge_gate 오케스트레이션 (Cage 합성·AC⑥) ──────────────────────────

def _patch_cage(*, gate_status="auto_passed", trust_scores=None, capture=None, participation=True):
    part = SimpleNamespace(member_id=uuid.uuid4(), role_id=uuid.uuid4()) if participation else None
    gate = SimpleNamespace(id=uuid.uuid4(), status=gate_status)
    ctx = [
        patch.object(mod, "resolve_implementation_participation", AsyncMock(return_value=part)),
        patch.object(mod, "_role_key", AsyncMock(return_value="implementation")),
        patch.object(mod, "capture_pr_ci_verdict",
                     AsyncMock(return_value=capture or {"recorded": ["pr"], "skipped_reason": None})),
        patch.object(mod, "compute_member_trust_scores",
                     AsyncMock(return_value=trust_scores or {"scores": [{"role_key": "implementation", "clean_pass_rate": 0.9}]})),
        patch.object(mod, "create_gate", AsyncMock(return_value=gate)),
    ]
    return ctx, gate


async def _run(**cage):
    import contextlib

    ctx, gate = _patch_cage(**cage)
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        create_spy = stack.enter_context(
            patch.object(mod, "create_gate", AsyncMock(return_value=gate))
        )
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=12, repo="o/r", ci_result="pass", pr_result="pass",
        )
    return res, create_spy


@pytest.mark.anyio
async def test_evaluate_auto_merge_path():
    res, create_spy = await _run(gate_status="auto_passed")
    assert res.decision == AUTO_MERGE and res.disposition == "allow_auto"
    assert res.trust == 0.9 and res.gate_id is not None
    create_spy.assert_awaited_once()  # AC⑥: gate row.


@pytest.mark.anyio
async def test_evaluate_trust_none_asks_and_still_creates_gate():
    # R5 초기 안전성: trust 전원 null → ask_human(auto_merge 0).
    res, create_spy = await _run(gate_status="auto_passed", trust_scores={"scores": []})
    assert res.decision == ASK_HUMAN and res.trust is None
    create_spy.assert_awaited_once()  # AC⑥: 사람 보류여도 gate row 남는다.


@pytest.mark.anyio
async def test_evaluate_ask_posture_path():
    res, _ = await _run(gate_status="pending")
    assert res.decision == ASK_HUMAN and res.disposition == "ask"


@pytest.mark.anyio
async def test_evaluate_no_participation_asks_no_gate():
    import contextlib

    ctx, gate = _patch_cage(participation=False)
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        create_spy = stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=1, repo="o/r", ci_result="pass",
        )
    assert res.decision == ASK_HUMAN and res.gate_id is None
    create_spy.assert_not_awaited()  # participation 없으면 gate도 안 만든다.


@pytest.mark.anyio
async def test_evaluate_ci_fail_blocks():
    import contextlib

    ctx, gate = _patch_cage(gate_status="auto_passed")
    with contextlib.ExitStack() as stack:
        for p in ctx:
            stack.enter_context(p)
        stack.enter_context(patch.object(mod, "create_gate", AsyncMock(return_value=gate)))
        res = await evaluate_merge_gate(
            AsyncMock(), uuid.uuid4(), uuid.uuid4(),
            pr_number=1, repo="o/r", ci_result="failure",
        )
    assert res.decision == BLOCK and res.ci_result == "fail"
