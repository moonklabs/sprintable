from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

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


class InboxItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    assignee_member_id: uuid.UUID
    from_agent_id: uuid.UUID | None = None
    story_id: uuid.UUID | None = None
    memo_id: uuid.UUID | None = None
    resolved_by: uuid.UUID | None = None
    kind: str
    title: str
    context: str | None = None
    agent_summary: str | None = None
    origin_chain: list[Any]
    options: list[Any]
    after_decision: str | None = None
    priority: str
    state: str
    resolved_option_id: uuid.UUID | None = None
    resolved_note: str | None = None
    source_type: str
    source_id: str
    waiting_since: datetime
    created_at: datetime
    resolved_at: datetime | None = None


class ResolveInboxItem(BaseModel):
    resolved_by: uuid.UUID
    resolved_option_id: uuid.UUID | None = None
    resolved_note: str | None = None
