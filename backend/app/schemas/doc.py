import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class DocCreate(BaseModel):
    project_id: uuid.UUID
    org_id: uuid.UUID
    title: str
    slug: str
    content: str = ""
    parent_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    icon: str | None = None
    sort_order: int = 0
    doc_type: str = "page"
    content_format: str = "markdown"
    tags: list[str] = []


class DocUpdate(BaseModel):
    title: str | None = None
    slug: str | None = None
    content: str | None = None
    parent_id: uuid.UUID | None = None
    icon: str | None = None
    sort_order: int | None = None
    doc_type: str | None = None
    content_format: str | None = None
    tags: list[str] | None = None


class DocResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    created_by: uuid.UUID | None = None
    title: str
    slug: str
    content: str
    icon: str | None = None
    sort_order: int
    doc_type: str
    content_format: str
    tags: list[str]
    created_at: datetime
    updated_at: datetime
