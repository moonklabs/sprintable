import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, computed_field

_ONLINE_THRESHOLD = timedelta(minutes=5)
_IDLE_THRESHOLD = timedelta(minutes=30)


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
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    # S2-1: Presence 필드
    last_seen_at: datetime | None = None
    active_story_id: uuid.UUID | None = None
    agent_status: str | None = None

    # S2-3: computed presence_status — 조회 시점 실시간 계산
    @computed_field
    @property
    def presence_status(self) -> str | None:
        if self.type == "human":
            return None
        if self.last_seen_at is None:
            return "offline"
        last = self.last_seen_at
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - last
        if delta <= _ONLINE_THRESHOLD:
            return "online"
        if delta <= _IDLE_THRESHOLD:
            return "idle"
        return "offline"
