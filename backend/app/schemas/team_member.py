import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class TeamMemberCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    type: str  # 'human' | 'agent'
    name: str
    role: str = "member"
    user_id: uuid.UUID | None = None
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    webhook_url: str | None = None
    color: str = "#3385f8"
    agent_role: str | None = None


class TeamMemberUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    webhook_url: str | None = None
    color: str | None = None
    agent_role: str | None = None
    is_active: bool | None = None


class TeamMemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID | None = None
    type: str
    name: str
    role: str
    avatar_url: str | None = None
    agent_config: dict[str, Any] | None = None
    webhook_url: str | None = None
    is_active: bool
    color: str
    agent_role: str | None = None
    created_at: datetime
    updated_at: datetime
