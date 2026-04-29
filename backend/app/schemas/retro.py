import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CreateSession(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    sprint_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None


class ItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    author_id: uuid.UUID | None = None
    category: str
    text: str
    vote_count: int
    created_at: datetime


class ActionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    title: str
    status: str
    created_at: datetime


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    title: str
    phase: str
    created_at: datetime
    updated_at: datetime
    items: list[ItemResponse] = []
    actions: list[ActionResponse] = []


class SessionListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    sprint_id: uuid.UUID | None = None
    title: str
    phase: str
    created_at: datetime
    updated_at: datetime


class PhaseTransition(BaseModel):
    phase: str


class CreateItem(BaseModel):
    category: str  # good | bad | improve
    text: str
    author_id: uuid.UUID | None = None


class CreateAction(BaseModel):
    title: str
    assignee_id: uuid.UUID | None = None


class UpdateAction(BaseModel):
    title: str | None = None
    assignee_id: uuid.UUID | None = None
    status: str | None = None


class VoteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    item_id: uuid.UUID
    voter_id: uuid.UUID
    created_at: datetime
