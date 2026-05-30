import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator

_METRIC_SOURCES = frozenset({"internal_ops", "ga4", "manual"})
_METRIC_DIRECTIONS = frozenset({"up", "down"})


def _validate_metric_definition(v: dict | None) -> dict | None:
    """metric_definition 구조 검증: {metric, source, target, direction} 필수."""
    if v is None:
        return v
    missing = {"metric", "source", "target", "direction"} - v.keys()
    if missing:
        raise ValueError(f"metric_definition에 필수 키 누락: {missing}")
    if v["source"] not in _METRIC_SOURCES:
        raise ValueError(f"metric_definition.source must be one of {_METRIC_SOURCES}")
    if v["direction"] not in _METRIC_DIRECTIONS:
        raise ValueError(f"metric_definition.direction must be one of {_METRIC_DIRECTIONS}")
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
