from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class WebhookConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    project_id: uuid.UUID | None = None
    url: str
    events: list[str]
    channel: str
    is_active: bool
    created_at: datetime


class UpsertWebhookConfig(BaseModel):
    member_id: uuid.UUID
    url: str
    project_id: uuid.UUID | None = None
    events: list[str] | None = None
    is_active: bool = True

    @field_validator("url")
    @classmethod
    def url_must_be_https(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("url must start with https://")
        return v
