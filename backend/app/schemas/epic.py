import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

EPIC_STATUSES = ("draft", "active", "done", "archived")
EPIC_PRIORITIES = ("critical", "high", "medium", "low")


class EpicCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    status: str = "active"
    priority: str = "medium"
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None


class EpicUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    priority: str | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    assignee_id: uuid.UUID | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None


class EpicResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    priority: str
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    outcome_status: str = "n_a"
    outcome_result: dict[str, Any] | None = None
    # E1 S8b: 연결 가설 집계(list 응답서 N+1 없이 부착). additive — 링크 0건이면
    # count 0 / risky None. risky_status는 최위험 1개(falsified>measuring>active>
    # proposed>verified>killed>archived). 미부착 경로(get/create/update)는 기본값.
    hypothesis_count: int = 0
    risky_status: str | None = None
    created_at: datetime
    updated_at: datetime


class EpicProgressResponse(BaseModel):
    epic_id: uuid.UUID
    total_stories: int
    done_stories: int
    total_sp: int
    done_sp: int
    completion_pct: int
