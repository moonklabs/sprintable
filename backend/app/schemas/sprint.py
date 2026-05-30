import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class SprintBase(BaseModel):
    title: str
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None
    # E-OUTCOME-LOOP: 의도 필드
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None


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
    # E-OUTCOME-LOOP: 의도 필드 (Update 허용)
    success_hypothesis: str | None = None
    metric_definition: dict[str, Any] | None = None
    measure_after: datetime | None = None
    # outcome_status/outcome_result는 Update 제외 — 채점잡 전용


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
