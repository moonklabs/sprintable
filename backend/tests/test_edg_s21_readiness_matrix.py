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
    # gradient: S26 완료로 5 엔티티 전부 gating_eligible(story/hyp/doc/epic/sprint). 미등록만 None.
    for e in ("story", "hypothesis", "doc", "epic", "sprint"):
        assert get_readiness(e).gating_eligible is True
        assert get_readiness(e).blocking_reason is None  # 승격 완료 → 사유 없음
    # 검증된 enum(SSOT import) — hypothesis/epic/sprint.
    hyp = get_readiness("hypothesis")
    assert hyp.status_enum is not None and "measuring" in hyp.status_enum
    # S23: valid_transitions = overlay-gated subset(proposed→active 만)·full FSM 은 hypothesis.py SSOT.
    assert hyp.valid_transitions == frozenset({("proposed", "active")})
    assert get_readiness("epic").status_enum == frozenset({"draft", "active", "done", "archived"})
    # S22 doc=native status 컬럼(0128)·draft→confirmed. S27 sprint=enum(planning..archived)·dispatch True.
    assert get_readiness("doc").has_native_status is True
    assert get_readiness("doc").valid_transitions == frozenset({("draft", "confirmed")})
    assert get_readiness("sprint").status_enum is not None and get_readiness("sprint").dispatch_capable is True
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
    # S26: sprint planning→active·active→closed overlay-gated(True)·closed→archived scope 밖.
    assert is_transition_supported("sprint", "planning", "active") is True
    assert is_transition_supported("sprint", "closed", "archived") is False
    # 미등록만 False(5 엔티티 전부 eligible).
    assert is_transition_supported("unknown", "a", "b") is False  # 미등록=no-op


def test_get_readiness_unknown_returns_none():
    assert get_readiness("nonexistent") is None


# ── 미지원 no-op 이 silent 아닐 것(④ observability) ──────────────────────────
def test_unsupported_attempt_emits_structured_log(caplog):
    # S26 후 5 엔티티 전부 eligible → 미지원 시도는 미등록 entity 로 검사(metric/observability 보존).
    with caplog.at_level(logging.INFO, logger="app.services.workflow_readiness_matrix"):
        record_unsupported_entity_attempt("widget", "a", "b", uuid.uuid4())
    rec = [r for r in caplog.records if "unsupported_entity_gate_attempt" in r.getMessage()]
    assert rec, "미지원 시도가 로그로 남아야 한다(silent 금지)"
    assert getattr(rec[0], "metric", None) == "unsupported_entity_gate_attempt_count"
    assert getattr(rec[0], "blocking_reason", None) == "unknown_entity_type"


def test_unsupported_attempt_unknown_entity_logs_reason(caplog):
    with caplog.at_level(logging.INFO, logger="app.services.workflow_readiness_matrix"):
        record_unsupported_entity_attempt("widget")
    rec = [r for r in caplog.records if "unsupported_entity_gate_attempt" in r.getMessage()]
    assert rec and getattr(rec[0], "blocking_reason", None) == "unknown_entity_type"


# ── routing context: 비-eligible 은 descriptor reason·unknown 은 unknown_entity_type ──
@pytest.mark.anyio
async def test_routing_context_non_eligible_returns_descriptor_reason():
    from app.services.workflow_line_resolver import resolve_routing_context
    session = AsyncMock()  # 미등록 entity 는 session.get 전에 반환 → DB 불필요
    # S26 후 5 등록 엔티티 전부 eligible → 비-eligible 검사는 미등록(widget)으로(unknown_entity_type).
    ctx = await resolve_routing_context(session, uuid.uuid4(), entity_type="widget", entity_id=uuid.uuid4())
    assert ctx["supported"] is False and ctx["reason"] == "unknown_entity_type"
    session.get.assert_not_called()  # 비-eligible 은 DB 안 침
