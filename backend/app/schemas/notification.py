from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    type: str
    title: str
    body: str | None = None
    is_read: bool
    reference_type: str | None = None
    reference_id: uuid.UUID | None = None
    created_at: datetime


class NotificationSettingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    channel: str
    event_type: str
    enabled: bool


class UpsertNotificationSetting(BaseModel):
    channel: str
    event_type: str
    enabled: bool = True


