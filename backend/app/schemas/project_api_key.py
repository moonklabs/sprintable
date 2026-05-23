import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class CreateProjectApiKeyRequest(BaseModel):
    name: str
    scope: list[str] | None = None
    plan_feature_ids: list[uuid.UUID] | None = None


class ProjectApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    created_by: uuid.UUID | None
    name: str
    key_prefix: str
    scope: list[str] | None
    plan_feature_ids: list[uuid.UUID] | None
    revoked_at: datetime | None
    created_at: datetime


class ProjectApiKeyCreatedResponse(ProjectApiKeyResponse):
    api_key: str = Field(description="One-time plaintext key — store securely")
