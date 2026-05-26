from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from app.core.ssrf import validate_webhook_url


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
    secret: str | None = Field(default=None, exclude=True)

    @computed_field
    @property
    def has_secret(self) -> bool:
        return bool(self.secret)


class UpsertWebhookConfig(BaseModel):
    member_id: uuid.UUID
    url: str
    project_id: uuid.UUID | None = None
    events: list[str] | None = None
    is_active: bool = True
    secret: str | None = None

    @field_validator("url")
    @classmethod
    def url_must_be_https(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("url must start with https://")
        validate_webhook_url(v)  # DNS resolve → private IP 차단 (SSRF 방어)
        return v

    @field_validator("secret", mode="before")
    @classmethod
    def empty_secret_to_none(cls, v: str | None) -> str | None:
        return v if v else None
