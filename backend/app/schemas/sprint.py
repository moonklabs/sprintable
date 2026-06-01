import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator
from app.schemas.story import _validate_metric_definition


class SprintBase(BaseModel):
    title: str
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None
    # E-BOARD-SCHEMA S4: 실행 목표(goal)·가용 공수(capacity)
    goal: str | None = None
    capacity: int | None = None
    # E-OUTCOME-LOOP: 효과 가설(success_hypothesis) — goal(실행 목표)과 별개
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)


class SprintCreate(SprintBase):
    project_id: uuid.UUID
    org_id: uuid.UUID


class SprintUpdate(BaseModel):
    title: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None
    status: str | None = None
    velocity: int | None = None
    duration: int | None = None
    report_doc_id: uuid.UUID | None = None
    # E-BOARD-SCHEMA S4
    goal: str | None = None
    capacity: int | None = None
    # E-OUTCOME-LOOP: 의도 필드 (Update 허용)
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # outcome_status/outcome_result는 Update 제외 — 채점잡 전용

    @field_validator("metric_definition")
    @classmethod
    def validate_metric_definition(cls, v: dict | None) -> dict | None:
        return _validate_metric_definition(v)


class SprintResponse(SprintBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    status: str
    velocity: int | None = None
    duration: int
    report_doc_id: uuid.UUID | None = None
    # E-OUTCOME-LOOP: 채점 필드
    outcome_status: str = "n_a"
    outcome_result: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class KickoffBody(BaseModel):
    message: str | None = None
