import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

REVIEW_TYPES = ("comment", "approve", "request_changes")


class StandupUpsert(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID | None = None
    author_id: uuid.UUID
    date: date
    sprint_id: uuid.UUID | None = None
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None
    plan_story_ids: list[uuid.UUID] = []


class StandupEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    author_id: uuid.UUID
    date: date
    done: str | None = None
    plan: str | None = None
    blockers: str | None = None
    plan_story_ids: list[uuid.UUID]
    created_at: datetime
    updated_at: datetime


class FeedbackCreate(BaseModel):
    org_id: uuid.UUID
    project_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    feedback_by_id: uuid.UUID
    review_type: str = "comment"
    feedback_text: str


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    standup_entry_id: uuid.UUID
    feedback_by_id: uuid.UUID
    review_type: str
    feedback_text: str
    created_at: datetime
    updated_at: datetime
