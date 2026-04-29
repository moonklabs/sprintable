import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict


class SprintBase(BaseModel):
    title: str
    start_date: date | None = None
    end_date: date | None = None
    team_size: int | None = None


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


class SprintResponse(SprintBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    status: str
    velocity: int | None = None
    duration: int
    report_doc_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class KickoffBody(BaseModel):
    message: str | None = None
