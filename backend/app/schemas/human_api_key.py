from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class HumanApiKeyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    name: str | None = None
    key_prefix: str
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime


class HumanApiKeyCreatedResponse(HumanApiKeyResponse):
    api_key: str


class CreateHumanApiKeyRequest(BaseModel):
    name: str | None = None
    expires_at: datetime | None = None
