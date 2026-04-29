import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

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
    created_at: datetime
    updated_at: datetime
