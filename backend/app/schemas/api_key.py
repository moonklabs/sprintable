from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    team_member_id: uuid.UUID
    key_prefix: str
    scope: list[str] | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime


class ApiKeyCreatedResponse(ApiKeyResponse):
    api_key: str


class RotateApiKeyRequest(BaseModel):
    api_key_id: uuid.UUID


class CreateApiKeyRequest(BaseModel):
    scope: list[str] | None = None
    expires_at: datetime | None = None
