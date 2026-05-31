import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ParticipationRoleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    key: str
    label: str
    is_default: bool
    created_at: datetime


class ParticipationCreate(BaseModel):
    story_id: uuid.UUID
    member_id: uuid.UUID
    role_id: uuid.UUID


class ParticipationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    story_id: uuid.UUID
    member_id: uuid.UUID
    role_id: uuid.UUID
    created_at: datetime
