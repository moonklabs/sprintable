"""P0-04 impl(doc trust-pipeline-be-design) — derive_trust_stage/derive_exception_signals 단위
테스트(순수함수·DB 무의존) + maybe_emit_trust_stage_changed 변경시에만 emit 격리 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.trust_pipeline import (
    TrustFacts,
    _maybe_emit,
    derive_exception_signals,
    derive_trust_stage,
)


def _facts(
    status: str,
    *,
    human_verified: bool = False,
    has_pending_human_gate: bool = False,
    has_verify_fail: bool = False,
    has_unresolved_blocker: bool = False,
    has_scope_violation: bool = False,
    project_id: uuid.UUID | None = None,
) -> TrustFacts:
    return TrustFacts(
        status=status,
        project_id=project_id or uuid.uuid4(),
        human_verified=human_verified,
        has_pending_human_gate=has_pending_human_gate,
        has_verify_fail=has_verify_fail,
        has_unresolved_blocker=has_unresolved_blocker,
        has_scope_violation=has_scope_violation,
    )


# ── derive_trust_stage: doc §2 6단계 표 그대로 ──────────────────────────────

@pytest.mark.parametrize("status", ["backlog", "ready-for-dev"])
def test_queued(status):
    assert derive_trust_stage(_facts(status)) == "queued"


def test_running_no_exception():
    assert derive_trust_stage(_facts("in-progress")) == "running"


def test_needs_input_when_pending_human_gate():
    assert derive_trust_stage(_facts("in-progress", has_pending_human_gate=True)) == "needs_input"


def test_claimed_done_when_not_human_verified():
    assert derive_trust_stage(_facts("in-review", human_verified=False)) == "claimed_done"


def test_verified_when_human_verified_but_blocked():
    assert derive_trust_stage(
        _facts("in-review", human_verified=True, has_unresolved_blocker=True)
    ) == "verified"


def test_verified_when_human_verified_but_verify_fail():
    assert derive_trust_stage(
        _facts("in-review", human_verified=True, has_verify_fail=True)
    ) == "verified"


def test_merge_ready_when_human_verified_and_clear():
    assert derive_trust_stage(_facts("in-review", human_verified=True)) == "merge_ready"


def test_done_is_outside_pipeline_scope():
    """§7 확定④ — done은 파이프라인 뷰 스코프 밖(None)."""
    assert derive_trust_stage(_facts("done", human_verified=True)) is None


def test_unknown_status_is_outside_pipeline_scope():
    assert derive_trust_stage(_facts("some-future-status")) is None


# ── derive_exception_signals: doc §3/§6 AQ 5신호 ────────────────────────────

def test_exception_signals_all_clear():
    signals = derive_exception_signals(_facts("in-review", human_verified=True))
    assert signals == {
        "blocked": False,
        "verify_fail": False,
        "needs_input": False,
        "scope_violation": False,
        "merge_ready": True,
    }


def test_exception_signals_blocked():
    signals = derive_exception_signals(
        _facts("in-review", human_verified=True, has_unresolved_blocker=True)
    )
    assert signals["blocked"] is True
    assert signals["merge_ready"] is False


def test_exception_signals_needs_input():
    signals = derive_exception_signals(_facts("in-progress", has_pending_human_gate=True))
    assert signals["needs_input"] is True
    assert signals["merge_ready"] is False


def test_scope_violation_false_when_no_signal():
    """174be6bc 실체화 — has_scope_violation=False(미선언/무신호)이면 다른 facts 조합과 무관하게 항상 False."""
    for status in ("backlog", "ready-for-dev", "in-progress", "in-review", "done"):
        for hv in (True, False):
            for gate in (True, False):
                for vf in (True, False):
                    for blocker in (True, False):
                        facts = _facts(
                            status, human_verified=hv, has_pending_human_gate=gate,
                            has_verify_fail=vf, has_unresolved_blocker=blocker,
                        )
                        assert derive_exception_signals(facts)["scope_violation"] is False


def test_scope_violation_true_passthrough():
    """174be6bc 실체화 — has_scope_violation=True는 다른 facts와 무관하게 신호 그대로 통과."""
    facts = _facts("in-review", human_verified=True, has_scope_violation=True)
    assert derive_exception_signals(facts)["scope_violation"] is True


# ── _maybe_emit: 변경시에만 emit(이벤트 폭주 방지·doc §4) ───────────────────

@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_maybe_emit_noop_when_stage_and_signals_unchanged():
    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    facts = _facts("in-review", human_verified=True)
    publish = MagicMock()
    with patch("app.routers.events.publish_event", publish):
        await _maybe_emit(AsyncMock(), org_id, story_id, facts, facts)
    publish.assert_not_called()


@pytest.mark.anyio
async def test_maybe_emit_fires_on_stage_change():
    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    before = _facts("in-progress", project_id=project_id)
    after = _facts("in-review", human_verified=False, project_id=project_id)
    publish = MagicMock()
    with patch("app.routers.events.publish_event", publish):
        await _maybe_emit(AsyncMock(), org_id, story_id, before, after)
    publish.assert_called_once()
    args, _ = publish.call_args
    assert args[0] == str(org_id)
    assert args[1] == "story.trust_stage_changed"
    payload = args[2]
    assert payload["story_id"] == str(story_id)
    assert payload["project_id"] == str(project_id)
    assert payload["old_stage"] == "running"
    assert payload["new_stage"] == "claimed_done"


@pytest.mark.anyio
async def test_maybe_emit_fires_on_signal_change_without_stage_change():
    """stage는 그대로(running)라도 예외신호(needs_input)만 바뀌면 emit — 신호도 계약 일부(doc §4)."""
    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    before = _facts("in-progress", has_pending_human_gate=False)
    after = _facts("in-progress", has_pending_human_gate=True)
    assert derive_trust_stage(before) == "running"
    assert derive_trust_stage(after) == "needs_input"  # (참고: 이 케이스는 실제로 stage도 바뀜)
    publish = MagicMock()
    with patch("app.routers.events.publish_event", publish):
        await _maybe_emit(AsyncMock(), org_id, story_id, before, after)
    publish.assert_called_once()


@pytest.mark.anyio
async def test_maybe_emit_noop_when_both_outside_pipeline_scope():
    """before·after 둘 다 파이프라인 밖(done)이면 old==new==None → no-op(호출자는 항상 실 TrustFacts
    스냅샷만 넘긴다 — before=None 케이스는 실사용에 없음)."""
    story_id = uuid.uuid4()
    org_id = uuid.uuid4()
    before = _facts("done", human_verified=True)
    after = _facts("done", human_verified=True)
    publish = MagicMock()
    with patch("app.routers.events.publish_event", publish):
        await _maybe_emit(AsyncMock(), org_id, story_id, before, after)
    publish.assert_not_called()
