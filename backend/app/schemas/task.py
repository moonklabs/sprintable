import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class TaskCreate(BaseModel):
    story_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    assignee_id: uuid.UUID | None = None
    status: str = "todo"
    story_points: int | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    status: str | None = None
    assignee_id: uuid.UUID | None = None
    story_points: int | None = None


class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    story_id: uuid.UUID
    org_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    story_points: int | None = None
    created_at: datetime
    updated_at: datetime
