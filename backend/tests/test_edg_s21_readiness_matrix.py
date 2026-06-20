"""E-DG S21: Entity readiness matrix + generic transition adapter.

핵심: matrix descriptor 정확성(검증된 enum·이질성 gradient)·is_transition_supported·미지원 no-op이
silent 아님(로그)·routing context 가 entity-specific reason 반환·status 함수 entity_type 파라미터화.
story 거동 byte-동일은 기존 edg_s3/s4/s5/s7 테스트가 커버(무회귀).
"""
from __future__ import annotations

import logging
import uuid
from unittest.mock import AsyncMock

import pytest

from app.services.workflow_readiness_matrix import (
    READINESS_MATRIX,
    get_readiness,
    is_transition_supported,
    record_unsupported_entity_attempt,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── matrix descriptor 정확성(② 검증된 enum·gradient) ──────────────────────────
def test_matrix_covers_five_entities_with_verified_contracts():
    assert set(READINESS_MATRIX) == {"story", "hypothesis", "epic", "sprint", "doc"}
    # gradient: story + hypothesis(S23) + doc(S22) gating_eligible. epic/sprint 아직 미가동.
    assert get_readiness("story").gating_eligible is True
    assert get_readiness("hypothesis").gating_eligible is True  # S23 flip
    assert get_readiness("doc").gating_eligible is True         # S22 flip
    assert get_readiness("epic").gating_eligible is True        # S25 flip
    for e in ("sprint",):
        assert get_readiness(e).gating_eligible is False
        assert get_readiness(e).blocking_reason  # 사유 명시(silent 금지)
    # 검증된 enum(SSOT import) — hypothesis/epic.
    hyp = get_readiness("hypothesis")
    assert hyp.status_enum is not None and "measuring" in hyp.status_enum
    # S23: valid_transitions = overlay-gated subset(proposed→active 만)·full FSM 은 hypothesis.py SSOT.
    assert hyp.valid_transitions == frozenset({("proposed", "active")})
    assert get_readiness("epic").status_enum == frozenset({"draft", "active", "done", "archived"})
    # S22: doc=native status 컬럼(0128)·draft→confirmed overlay·sprint=enum 없음(free-string).
    assert get_readiness("doc").has_native_status is True
    assert get_readiness("doc").valid_transitions == frozenset({("draft", "confirmed")})
    assert get_readiness("sprint").status_enum is None and get_readiness("sprint").has_native_status is True
    # story=config-driven(모델 enum 상수 없음).
    assert get_readiness("story").status_enum is None and get_readiness("story").valid_transitions is None


def test_is_transition_supported_only_eligible():
    assert is_transition_supported("story", "backlog", "ready-for-dev") is True
    # S23: hypothesis proposed→active 는 overlay-gated(True)·그 외 hyp 전이는 scope 밖(False·native 직행).
    assert is_transition_supported("hypothesis", "proposed", "active") is True
    assert is_transition_supported("hypothesis", "active", "measuring") is False
    # S22: doc draft→confirmed overlay-gated(True)·그 외 doc 전이는 scope 밖.
    assert is_transition_supported("doc", "draft", "confirmed") is True
    assert is_transition_supported("doc", "confirmed", "superseded") is False
    # S25: epic draft→active·active→done overlay-gated(True)·done→archived scope 밖.
    assert is_transition_supported("epic", "draft", "active") is True
    assert is_transition_supported("epic", "done", "archived") is False
    # 비-eligible(sprint) + 미등록은 False.
    assert is_transition_supported("sprint", "planning", "active") is False
    assert is_transition_supported("unknown", "a", "b") is False  # 미등록=no-op


def test_get_readiness_unknown_returns_none():
    assert get_readiness("nonexistent") is None


# ── 미지원 no-op 이 silent 아닐 것(④ observability) ──────────────────────────
def test_unsupported_attempt_emits_structured_log(caplog):
    with caplog.at_level(logging.INFO, logger="app.services.workflow_readiness_matrix"):
        record_unsupported_entity_attempt("sprint", "planning", "active", uuid.uuid4())
    rec = [r for r in caplog.records if "unsupported_entity_gate_attempt" in r.getMessage()]
    assert rec, "미지원 시도가 로그로 남아야 한다(silent 금지)"
    assert getattr(rec[0], "metric", None) == "unsupported_entity_gate_attempt_count"
    assert getattr(rec[0], "blocking_reason", None) == "status_enum_undefined_pending_s26"


def test_unsupported_attempt_unknown_entity_logs_reason(caplog):
    with caplog.at_level(logging.INFO, logger="app.services.workflow_readiness_matrix"):
        record_unsupported_entity_attempt("widget")
    rec = [r for r in caplog.records if "unsupported_entity_gate_attempt" in r.getMessage()]
    assert rec and getattr(rec[0], "blocking_reason", None) == "unknown_entity_type"


# ── routing context: 비-eligible 은 descriptor reason·unknown 은 unknown_entity_type ──
@pytest.mark.anyio
async def test_routing_context_non_eligible_returns_descriptor_reason():
    from app.services.workflow_line_resolver import resolve_routing_context
    session = AsyncMock()  # 비-eligible 은 session.get 전에 반환 → DB 불필요
    # S23 hypothesis·S22 doc 는 eligible 승격(session.get 경로) → 여기선 비-eligible(epic/sprint)만 검사.
    for entity, reason in [
        ("sprint", "status_enum_undefined_pending_s26"),
    ]:
        ctx = await resolve_routing_context(session, uuid.uuid4(), entity_type=entity, entity_id=uuid.uuid4())
        assert ctx["supported"] is False and ctx["reason"] == reason
        assert ctx["suggested_default"] == "ask_human"
    # 미등록 entity → unknown_entity_type(fail-open·예외 아님)
    ctx = await resolve_routing_context(session, uuid.uuid4(), entity_type="widget", entity_id=uuid.uuid4())
    assert ctx["supported"] is False and ctx["reason"] == "unknown_entity_type"
    session.get.assert_not_called()  # 비-eligible 은 DB 안 침
