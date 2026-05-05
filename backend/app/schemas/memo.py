import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class MemoEntityLinkCreate(BaseModel):
    entity_type: Literal['story', 'doc', 'epic', 'task']
    entity_id: uuid.UUID
    position: int = 0


class MemoEntityLinkResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    memo_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    position: int
    created_at: datetime
    title: str | None = None
    status: str | None = None


class CreateMemo(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    content: str
    memo_type: str = "memo"
    title: str | None = None
    assigned_to: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    supersedes_id: uuid.UUID | None = None
    memo_metadata: dict[str, Any] = {}
    embeds: list[MemoEntityLinkCreate] = []


class UpdateMemo(BaseModel):
    title: str | None = None
    content: str | None = None
    assigned_to: uuid.UUID | None = None
    status: str | None = None
    memo_metadata: dict[str, Any] | None = None


class MemoListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    memo_type: str
    title: str | None = None
    content: str
    created_by: uuid.UUID | None = None
    assigned_to: uuid.UUID | None = None
    status: str
    supersedes_id: uuid.UUID | None = None
    resolved_by: uuid.UUID | None = None
    resolved_at: datetime | None = None
    archived_at: datetime | None = None
    memo_metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    embed_count: int = 0


class CreateReply(BaseModel):
    content: str
    created_by: uuid.UUID
    review_type: str = "comment"
    assigned_to_ids: list[uuid.UUID] | None = None


class ReplyResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    memo_id: uuid.UUID
    created_by: uuid.UUID
    content: str
    review_type: str
    created_at: datetime


class MemoResponse(MemoListResponse):
    deleted_at: datetime | None = None
    replies: list[ReplyResponse] = []
    reply_count: int = 0
    embeds: list[MemoEntityLinkResponse] = []
