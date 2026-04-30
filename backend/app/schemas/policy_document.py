from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PolicyDocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    sprint_id: uuid.UUID
    epic_id: uuid.UUID
    title: str
    content: str
    legacy_sprint_key: str | None = None
    legacy_epic_key: str | None = None
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
