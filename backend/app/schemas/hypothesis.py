"""E1-S2: Hypothesis Pydantic schemas (블루프린트 §3.2~§3.8).

metric_definition은 기존 Story validator(`_validate_metric_definition`)를 재사용한다 —
{metric, source, target, direction} 공통 필수 + GA4 추가 필수. Hypothesis에서는
metric_definition이 NOT NULL이라 create/transition 경로에서 None을 거부한다.
"""
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.story import _validate_metric_definition

# §2.5 상태 7종 (모델 HYPOTHESIS_STATUSES와 동기)
HYPOTHESIS_STATUSES = (
    "proposed", "active", "measuring", "verified", "falsified", "killed", "archived",
)
# transition endpoint가 허용하는 목표 상태(생성 시 proposed는 별도)
TRANSITION_TARGETS = ("active", "measuring", "verified", "falsified", "killed", "archived")
LINK_TYPES = ("primary", "supports")


class HypothesisCreate(BaseModel):
    project_id: uuid.UUID
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    owner_member_id: uuid.UUID | None = None
    status: str = "proposed"
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    source_type: str | None = None
    source_id: uuid.UUID | None = None
    draft_metadata: dict[str, Any] | None = None

    @field_validator("metric_definition")
    @classmethod
    def _check_metric(cls, v: dict[str, Any]) -> dict[str, Any]:
        # NOT NULL — None은 Pydantic 타입에서 이미 거부. 구조는 Story validator 재사용.
        return _validate_metric_definition(v)  # type: ignore[return-value]


class HypothesisUpdate(BaseModel):
    """§3.5 allowlist — status/outcome_result 직접 수정 금지(전이 endpoint 전용)."""
    statement: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    owner_member_id: uuid.UUID | None = None
    confidence: float | None = None
    draft_metadata: dict[str, Any] | None = None
    human_accounting: dict[str, Any] | None = None

    @field_validator("metric_definition")
    @classmethod
    def _check_metric(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return _validate_metric_definition(v)


class HypothesisTransition(BaseModel):
    status: str
    note: str | None = None
    outcome_result: dict[str, Any] | None = None


class HypothesisLinkRequest(BaseModel):
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    link_type: str | None = None


class HypothesisUnlinkRequest(BaseModel):
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []


class HypothesisResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    owner_member_id: uuid.UUID
    created_by_member_id: uuid.UUID | None = None
    confirmed_by_member_id: uuid.UUID | None = None
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    status: str
    outcome_result: dict[str, Any] | None = None
    confidence: float | None = None
    source_type: str | None = None
    source_id: uuid.UUID | None = None
    human_accounting: dict[str, Any]
    gate_contract: dict[str, Any]
    epic_ids: list[uuid.UUID] = []
    story_ids: list[uuid.UUID] = []
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(
        cls,
        obj: Any,
        epic_ids: list[uuid.UUID] | None = None,
        story_ids: list[uuid.UUID] | None = None,
    ) -> "HypothesisResponse":
        # epic_ids/story_ids는 모델 컬럼이 아니라 링크 테이블 집계 — 서비스가 주입한다.
        resp = cls.model_validate(obj)
        resp.epic_ids = epic_ids or []
        resp.story_ids = story_ids or []
        return resp


class HypothesisDraftRequest(BaseModel):
    """§3.9 — 흐름 부산물에서 AI 초안 생성. persist=true이면 status='proposed' row만 생성."""
    project_id: uuid.UUID
    source_type: str  # "epic" | "story" | "conversation" | "dispatch"
    source_id: uuid.UUID
    context: dict[str, Any] | None = None
    persist: bool = False


class HypothesisDraftResponse(BaseModel):
    statement: str
    metric_definition: dict[str, Any]
    measure_after: datetime
    source_snapshot: dict[str, Any]
    confidence: float | None = None
    requires_confirmation: bool = True
    # persist=true일 때만 — 생성된 proposed row.
    hypothesis: HypothesisResponse | None = None
