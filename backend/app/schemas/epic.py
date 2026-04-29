import uuid
from datetime import date, datetime

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


class EpicUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    priority: str | None = None
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None


class EpicResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    status: str
    priority: str
    description: str | None = None
    objective: str | None = None
    success_criteria: str | None = None
    target_sp: int | None = None
    target_date: date | None = None
    created_at: datetime
    updated_at: datetime


class EpicProgressResponse(BaseModel):
    epic_id: uuid.UUID
    total_stories: int
    done_stories: int
    total_sp: int
    done_sp: int
    completion_pct: int
