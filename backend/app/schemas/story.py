import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

_METRIC_SOURCES = frozenset({"internal_ops", "ga4", "manual"})
_METRIC_DIRECTIONS = frozenset({"up", "down"})
# GA4 지원 지표명 (모르는 지표 → pending 가드)
_GA4_SUPPORTED_METRICS = frozenset({
    "activeUsers", "newUsers", "sessions", "conversions", "eventCount", "screenPageViews",
})


def _validate_metric_definition(v: dict | None) -> dict | None:
    """metric_definition 구조 검증.

    공통 필수: {metric, source, target, direction}
    GA4 추가 필수: {property_id, ga4_metric, date_range_days}
    """
    if v is None:
        return v
    missing = {"metric", "source", "target", "direction"} - v.keys()
    if missing:
        raise ValueError(f"metric_definition에 필수 키 누락: {missing}")
    if v["source"] not in _METRIC_SOURCES:
        raise ValueError(f"metric_definition.source must be one of {_METRIC_SOURCES}")
    if v["direction"] not in _METRIC_DIRECTIONS:
        raise ValueError(f"metric_definition.direction must be one of {_METRIC_DIRECTIONS}")
    # GA4 전용 필드 검증 (E-OUTCOME-LOOP S5)
    if v["source"] == "ga4":
        ga4_missing = {"property_id", "ga4_metric", "date_range_days"} - v.keys()
        if ga4_missing:
            raise ValueError(f"GA4 metric_definition에 필수 키 누락: {ga4_missing}")
        if v["ga4_metric"] not in _GA4_SUPPORTED_METRICS:
            raise ValueError(f"ga4_metric must be one of {_GA4_SUPPORTED_METRICS}")
        if not isinstance(v["date_range_days"], int) or v["date_range_days"] <= 0:
            raise ValueError("date_range_days must be a positive integer")
    return v

STORY_STATUSES = ("backlog", "ready-for-dev", "in-progress", "in-review", "done")
STATUS_TRANSITIONS: dict[str, str] = {
    "backlog": "ready-for-dev",
    "ready-for-dev": "in-progress",
    "in-progress": "in-review",
    "in-review": "done",
}


class StoryCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    epic_id: uuid.UUID | None = None
    sprint_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    meeting_id: uuid.UUID | None = None
    status: str = "backlog"
    priority: str = "medium"
    story_points: int | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    position: int | None = None
    # E-OUTCOME-LOOP: 의도 필드
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)


class StoryUpdate(BaseModel):
    title: str | None = None
    epic_id: uuid.UUID | None = None
    sprint_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    meeting_id: uuid.UUID | None = None
    priority: str | None = None
    story_points: int | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    position: int | None = None
    # E-OUTCOME-LOOP: 의도 필드 (Update 허용)
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # outcome_status/outcome_result는 Update 제외 — 채점잡 전용

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)


class StoryStatusUpdate(BaseModel):
    status: str


class StoryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    epic_id: uuid.UUID | None = None
    sprint_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None
    meeting_id: uuid.UUID | None = None
    title: str
    status: str
    priority: str
    story_points: int | None = None
    description: str | None = None
    acceptance_criteria: str | None = None
    position: int | None = None
    # E-OUTCOME-LOOP: 의도 필드
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # E-OUTCOME-LOOP: 채점 필드
    outcome_status: str = "n_a"
    outcome_result: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
