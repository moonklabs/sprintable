from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ChangeSummary(BaseModel):
    added_rules: int = 0
    removed_rules: int = 0
    changed_rules: int = 0


class WorkflowVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    version: int
    snapshot: list[dict[str, Any]]
    change_summary: ChangeSummary
    created_by: uuid.UUID | None = None
    created_at: datetime
