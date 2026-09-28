import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from app.core.datetime_query import OffsetDatetime
from app.models.meeting import MEETING_TYPES
from app.schemas.not_null_fields import RejectsExplicitNull

# story #4329 — DB enum `meeting_type`과 같은 값 넷. 그 밖의 값은 DB 오류(500)가 아니라 요청 검증(422)으로 거절한다.
# story #4337 — 값은 모델의 MEETING_TYPES 한 곳에서(여기서 다시 적지 않는다).
MeetingType = Literal[MEETING_TYPES]  # type: ignore[valid-type]

__all__ = ["MEETING_TYPES", "MeetingType", "MeetingCreate", "MeetingUpdate", "MeetingResponse"]


class MeetingCreate(RejectsExplicitNull):
    # story #4337 — date는 생략하면 서버 기본값(now()) · 명시 null은 422(DB 칸 NOT NULL).
    NOT_NULL_FIELDS = frozenset({"date"})

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


class MeetingUpdate(RejectsExplicitNull):
    # story #4337 — 생략 = 그대로 · 명시 null은 422(모두 DB 칸 NOT NULL — 예전엔 update().values(x=None)로 500).
    NOT_NULL_FIELDS = frozenset({"title", "meeting_type", "date", "participants", "decisions", "action_items"})

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
