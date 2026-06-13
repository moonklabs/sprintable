"""H1-S5: board in-review→done 게이트 + 롤아웃 안전 플래그 테스트.

merge_gate_active(flag+allowlist 단일 스위치) + _preflight_merge_gate(board 직접 PATCH 게이팅).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.merge_verdict_gate import ASK_HUMAN, AUTO_MERGE, MergeGateDecision, merge_gate_active


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── merge_gate_active: 단일 스위치(flag + allowlist) ───────────────────────────

def test_gate_inactive_when_flag_off():
    with patch("app.services.merge_verdict_gate.settings") as s:
        s.h1_merge_gate_enabled = False
        s.h1_merge_gate_org_allowlist = ""
        assert merge_gate_active(uuid.uuid4()) is False  # AC①: off=미호출.


def test_gate_active_all_orgs_when_enabled_empty_allowlist():
    with patch("app.services.merge_verdict_gate.settings") as s:
        s.h1_merge_gate_enabled = True
        s.h1_merge_gate_org_allowlist = ""
        assert merge_gate_active(uuid.uuid4()) is True


def test_gate_active_only_allowlisted_org():
    org = uuid.uuid4()
    with patch("app.services.merge_verdict_gate.settings") as s:
        s.h1_merge_gate_enabled = True
        s.h1_merge_gate_org_allowlist = f"{org}, {uuid.uuid4()}"
        assert merge_gate_active(org) is True  # allowlist 안.
        assert merge_gate_active(uuid.uuid4()) is False  # allowlist 밖.


def test_gate_allowlist_ignores_invalid_ids():
    org = uuid.uuid4()
    with patch("app.services.merge_verdict_gate.settings") as s:
        s.h1_merge_gate_enabled = True
        s.h1_merge_gate_org_allowlist = f"not-a-uuid, {org}"
        assert merge_gate_active(org) is True
        assert merge_gate_active(uuid.uuid4()) is False


# ── _preflight_merge_gate: board 직접 PATCH 게이팅 ─────────────────────────────

def _story(status="in-review"):
    return SimpleNamespace(id=uuid.uuid4(), status=status)


def _decision(decision):
    return MergeGateDecision(
        decision=decision, reason="r", gate_id=uuid.uuid4(), gate_status="pending",
        disposition="ask", trust=None, ci_result=None,
    )


@pytest.mark.anyio
async def test_preflight_noop_when_not_done():
    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock()) as ev:
        await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("in-review"), "in-progress")
    ev.assert_not_awaited()  # done 아니면 게이트 0.


_PART = SimpleNamespace(id=uuid.uuid4(), member_id=uuid.uuid4(), role_id=uuid.uuid4())


@pytest.mark.anyio
async def test_preflight_noop_when_no_participation():
    # fc06fa8d(④·AC②): impl participation 없는 trivial todo→done은 skip(마찰 0).
    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=None)), \
         patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock()) as ev:
        await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("todo"), "done")
    ev.assert_not_awaited()


@pytest.mark.anyio
async def test_preflight_gates_non_in_review_with_participation():
    # fc06fa8d(④·AC①③): 출발 status 무관(rfd/todo→done)도 participation 보유면 게이트 발화(우회 박멸).
    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=_PART)), \
         patch("app.routers.stories.evaluate_merge_gate",
               new=AsyncMock(return_value=_decision(AUTO_MERGE))) as ev:
        await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("ready-for-dev"), "done")
    ev.assert_awaited_once()  # in-review 아닌 경로도 게이트 통과 강제.


@pytest.mark.anyio
async def test_preflight_noop_when_flag_off():
    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.merge_gate_active", return_value=False), \
         patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock()) as ev:
        await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("in-review"), "done")
    ev.assert_not_awaited()  # AC①: 플래그 off면 게이트 0(기존 PATCH 무변경).


@pytest.mark.anyio
async def test_preflight_passes_when_auto_merge():
    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=_PART)), \
         patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock(return_value=_decision(AUTO_MERGE))):
        await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("in-review"), "done")
    # 예외 없음 = 전이 허용.


@pytest.mark.anyio
async def test_preflight_blocks_409_when_not_auto_merge():
    from fastapi import HTTPException

    from app.routers.stories import _preflight_merge_gate
    db = AsyncMock()
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=_PART)), \
         patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock(return_value=_decision(ASK_HUMAN))):
        with pytest.raises(HTTPException) as ei:
            await _preflight_merge_gate(db, uuid.uuid4(), _story("in-review"), "done")
    assert ei.value.status_code == 409  # AC②: active+증거부족 → 전이 차단.
    assert ei.value.detail["code"] == "MERGE_GATE_PENDING"
    db.commit.assert_awaited_once()  # gate audit 보존.


# ── [gate] advisory(B) 모드: eval/record는 하되 차단(409) 면제 ─────────────────────

@pytest.mark.anyio
async def test_merge_gate_advisory_flag():
    from app.services.merge_verdict_gate import merge_gate_advisory
    with patch("app.services.merge_verdict_gate.settings") as s:
        s.h1_merge_gate_advisory = True
        assert merge_gate_advisory() is True
        s.h1_merge_gate_advisory = False
        assert merge_gate_advisory() is False


@pytest.mark.anyio
async def test_preflight_advisory_passes_without_block():
    # AC①④: advisory=true면 decision≠AUTO_MERGE여도 차단 0(done 통과)·단 eval/gate audit은 수행.
    from app.routers.stories import _preflight_merge_gate
    db = AsyncMock()
    ev = AsyncMock(return_value=_decision(ASK_HUMAN))
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=_PART)), \
         patch("app.routers.stories.evaluate_merge_gate", new=ev), \
         patch("app.routers.stories.merge_gate_advisory", return_value=True):
        await _preflight_merge_gate(db, uuid.uuid4(), _story("ready-for-dev"), "done")  # 예외 없음.
    ev.assert_awaited_once()        # eval은 그대로 수행(decision/gate row/metrics 기록·AC③).
    db.commit.assert_awaited_once()  # gate audit 보존.


@pytest.mark.anyio
async def test_preflight_enforcing_still_blocks_when_advisory_off():
    # AC②: advisory=false면 현 enforcing 보존(409 차단).
    from fastapi import HTTPException

    from app.routers.stories import _preflight_merge_gate
    with patch("app.routers.stories.merge_gate_active", return_value=True), \
         patch("app.routers.stories.resolve_implementation_participation", new=AsyncMock(return_value=_PART)), \
         patch("app.routers.stories.evaluate_merge_gate", new=AsyncMock(return_value=_decision(ASK_HUMAN))), \
         patch("app.routers.stories.merge_gate_advisory", return_value=False):
        with pytest.raises(HTTPException) as ei:
            await _preflight_merge_gate(AsyncMock(), uuid.uuid4(), _story("in-review"), "done")
    assert ei.value.status_code == 409
