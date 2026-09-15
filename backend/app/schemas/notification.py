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
    # story #3903(migration 0378, additive) — conversation.mention/conversation.message만
    # 채움(sender_name + 이벤트 발행 메시지면 event_key/payload/refs). FE가 렌더 시점에
    # eventCard 조합·제목 조합 재료로 쓴다. None이면(옛 행·다른 발행 경로) title/body 폴백.
    event: dict[str, Any] | None = None
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


