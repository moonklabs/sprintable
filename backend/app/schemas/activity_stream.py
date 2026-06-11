import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ActivityStreamItem(BaseModel):
    """canonical 활동 1행(L1 BE-5). delivery-only status/read는 노출하지 않는다(AC⑤)."""

    model_config = ConfigDict(from_attributes=True)

    activity_id: uuid.UUID
    project_id: uuid.UUID
    actor_id: uuid.UUID | None = None
    verb: str
    object_type: str | None = None
    object_id: uuid.UUID | None = None
    occurred_at: datetime
    source_event_ids: list[uuid.UUID]
    recipient_ids: list[uuid.UUID]
    recipient_types: list[str]
    payload: dict[str, Any]
    activity_seq: int


class ActivityStreamResponse(BaseModel):
    items: list[ActivityStreamItem]
    # activity_seq ASC cursor: 다음 페이지는 ?after_seq=next_after_seq. None이면 더 없음.
    next_after_seq: int | None = None
