import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from app.core.datetime_query import OffsetDatetime

# story #4329 — DB enum `meeting_type`과 같은 값 넷. 그 밖의 값은 DB 오류(500)가 아니라 요청 검증(422)으로 거절한다.
MeetingType = Literal["standup", "retro", "general", "review"]

MEETING_TYPES = ("standup", "retro", "general", "review")


class MeetingCreate(BaseModel):
    project_id: uuid.UUID
    title: str
    meeting_type: MeetingType = "general"
    date: OffsetDatetime | None = None
    duration_min: int | None = None
    participants: list[Any] = []
    raw_transcript: str | None = None
    ai_summary: str | None = None
    decisions: list[Any] = []
    action_items: list[Any] = []
    created_by: uuid.UUID | None = None


class MeetingUpdate(BaseModel):
    title: str | None = None
    meeting_type: MeetingType | None = None
    date: OffsetDatetime | None = None
    duration_min: int | None = None
    participants: list[Any] | None = None
    raw_transcript: str | None = None
    ai_summary: str | None = None
    decisions: list[Any] | None = None
    action_items: list[Any] | None = None


class MeetingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    created_by: uuid.UUID | None = None
    title: str
    meeting_type: str
    date: datetime
    duration_min: int | None = None
    participants: list[Any]
    raw_transcript: str | None = None
    ai_summary: str | None = None
    decisions: list[Any]
    action_items: list[Any]
    created_at: datetime
    updated_at: datetime
