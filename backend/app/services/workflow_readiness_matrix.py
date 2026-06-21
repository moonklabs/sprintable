"""E-DECISION-GATE S21: Entity readiness matrix (Phase 2 foundation).

Phase 1 라인 엔진은 story 에 하드코딩돼 있다(routing/resolution/status-read). Phase 2 는 이를
doc/hypothesis/epic/sprint 로 확장하되, **엔티티별 readiness 이질성을 무시한 generic code 를 막는** 것이
핵심(success_hypothesis). 이 모듈은 그 이질성을 **명시적 descriptor 행렬**로 인코딩한다.

⭐설계 원칙:
- **순수 데이터**(callable/엔진 import 0) → 순환 의존 없음. 엔티티별 실제 로직(predicate/status setter/
  fetch)은 각 서비스에 inline 유지하고, 이 모듈은 "지원 여부 + 사유 + enum 계약"만 SSOT 로 보유한다.
- **gating_eligible**: S21 시점 routing/resolution 게이트가 실가동하는 엔티티(= story 만). 나머지는
  False + blocking_reason 으로 "왜 아직 아닌지"를 명시(S22~S26 에서 승격).
- **미지원 = 명시 no-op**(silent 아님): ``record_unsupported_entity_attempt`` 로 구조화 로그를 남겨
  observability 를 보장한다(§6: engine 실패 ≠ silent skip).
- **fail-open 정합**: matrix miss/미지원은 transition 을 막지 않는다(409 아님). gate 미생성일 뿐.

⚠️ enum/전이 값은 각 모델/스키마의 SSOT 를 import 해 재사용한다(중복 정의 금지 → S22+ 오염 방지).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from app.models.doc import DOC_STATUSES
from app.models.hypothesis import HYPOTHESIS_STATUSES
from app.schemas.epic import EPIC_STATUSES
from app.schemas.sprint import SPRINT_STATUSES

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EntityReadiness:
    """엔티티 1종의 line-readiness 계약(이질성 인코딩)."""

    entity_type: str
    has_native_status: bool
    # status 유효값 집합. None = enum 계약 없음(story=config-driven · sprint=free-string · doc=status無).
    status_enum: frozenset[str] | None
    # 합법 (from,to) 전이. None = 모델 레벨 전이규칙 없음(story=config · epic/sprint 미정의).
    valid_transitions: frozenset[tuple[str, str]] | None
    # S21 시점 routing/resolution 게이트 실가동 여부(현재 story 만 True).
    gating_eligible: bool
    # agent_dispatch._fetch_entity 가 이 엔티티를 로드할 수 있는지(현 epic/story/doc/hypothesis/sprint).
    dispatch_capable: bool
    # gating_eligible=False 인 이유(observability/후속 스토리 라우팅). eligible 이면 None.
    blocking_reason: str | None


# ⭐ Entity Readiness Matrix — 이질성 gradient(Story FULL → Hyp READY → Epic PARTIAL → Sprint WEAK → Doc NONE).
# enum/전이 값은 SSOT import(hypothesis.py:39/44 · schemas/epic.py:7). story status 는 config-driven
# (workflow_line_seed.py:37-49)이라 모델 상수 없음 → enum/transitions=None.
READINESS_MATRIX: dict[str, EntityReadiness] = {
    "story": EntityReadiness(
        entity_type="story",
        has_native_status=True,                 # pm.py:101 String(30)
        status_enum=None,                        # config-driven(seed) → 모델 enum 상수 없음
        valid_transitions=None,                  # config 라인이 전이 정의(엔진 Phase1)
        gating_eligible=True,                    # Phase1 = story 라인 dogfood
        dispatch_capable=True,
        blocking_reason=None,
    ),
    "hypothesis": EntityReadiness(
        entity_type="hypothesis",
        has_native_status=True,                  # hypothesis.py:81 String(24)
        status_enum=frozenset(HYPOTHESIS_STATUSES),       # hypothesis.py:39
        # ⭐S23: overlay-gated subset = proposed→active 만(full native FSM 은 hypothesis.py:44 SSOT).
        # measuring/verified 등 나머지 전이는 line overlay 안 검·native 직행(scope 명확).
        valid_transitions=frozenset({("proposed", "active")}),
        gating_eligible=True,                    # S23: proposed→active overlay 가동
        dispatch_capable=True,                   # S23: _fetch_entity hypothesis 분기 추가
        blocking_reason=None,
    ),
    "epic": EntityReadiness(
        entity_type="epic",
        has_native_status=True,                  # pm.py:59 String(20)
        status_enum=frozenset(EPIC_STATUSES),    # schemas/epic.py:7 (draft|active|done|archived)
        # ⭐S25: overlay-gated subset = draft→active·active→done(full FSM 은 epic.py _EPIC_VALID_TRANSITIONS).
        valid_transitions=frozenset({("draft", "active"), ("active", "done")}),
        gating_eligible=True,                    # S25: epic activation/completion overlay 가동
        dispatch_capable=True,
        blocking_reason=None,
    ),
    "sprint": EntityReadiness(
        entity_type="sprint",
        has_native_status=True,                  # pm.py:23 String(20) default planning
        status_enum=frozenset(SPRINT_STATUSES),   # S26: schemas/sprint.py SPRINT_STATUSES
        # ⭐S26: overlay-gated = 시작(planning→active)·마감(active→closed·review→closed). full FSM 은
        # sprint.py _SPRINT_VALID_TRANSITIONS SSOT. archive(closed→archived)는 native 직행.
        valid_transitions=frozenset({("planning", "active"), ("active", "closed"), ("review", "closed")}),
        gating_eligible=True,                    # S26: sprint contract gate(advisory)
        dispatch_capable=True,                   # S27: sprint dispatch anchor enabled(project owner/admin relay)
        blocking_reason=None,
    ),
    "doc": EntityReadiness(
        entity_type="doc",
        has_native_status=True,                  # S22(A): docs.status native 컬럼(0128·doc-specific 값)
        status_enum=frozenset(DOC_STATUSES),      # doc.py DOC_STATUSES(draft|confirmed|denied|superseded|deprecated)
        # ⭐S22: overlay-gated subset = draft→confirmed 만(full FSM 은 doc.py _DOC_VALID_TRANSITIONS SSOT).
        valid_transitions=frozenset({("draft", "confirmed")}),
        gating_eligible=True,                     # S22: draft→confirmed overlay 가동
        dispatch_capable=True,
        blocking_reason=None,
    ),
}


def get_readiness(entity_type: str) -> EntityReadiness | None:
    """엔티티 readiness descriptor. 미등록 → None(예외 아님·호출자가 fail-open 처리)."""
    return READINESS_MATRIX.get(entity_type)


def is_transition_supported(entity_type: str, from_status: str, to_status: str) -> bool:
    """이 엔티티+전이가 라인 게이트 실가동 대상인가. 미등록/비-eligible → False(no-op).

    valid_transitions 가 정의된 엔티티(hypothesis)는 전이 합법성까지 검사하나, story 처럼 config-driven
    (valid_transitions=None)이면 eligible 여부만으로 판정(전이 합법성은 config lint/엔진 책임).
    """
    desc = READINESS_MATRIX.get(entity_type)
    if desc is None or not desc.gating_eligible:
        return False
    if desc.valid_transitions is not None:
        return (from_status, to_status) in desc.valid_transitions
    return True


def record_unsupported_entity_attempt(
    entity_type: str, from_status: str | None = None, to_status: str | None = None,
    entity_id: uuid.UUID | None = None,
) -> None:
    """미지원 엔티티 라인 시도를 구조화 로그로 남긴다(§6: no-op 이 silent 아닐 것).

    metric `unsupported_entity_gate_attempt_count` 의 로그-기반 소스. 실패가 아니라 "아직 미지원"
    관측치이므로 warning 이 아닌 info 레벨(fail-open 정합).
    """
    desc = READINESS_MATRIX.get(entity_type)
    logger.info(
        "unsupported_entity_gate_attempt entity_type=%s reason=%s from=%s to=%s entity_id=%s",
        entity_type,
        desc.blocking_reason if desc else "unknown_entity_type",
        from_status, to_status, entity_id,
        extra={
            "metric": "unsupported_entity_gate_attempt_count",
            "entity_type": entity_type,
            "blocking_reason": desc.blocking_reason if desc else "unknown_entity_type",
        },
    )
