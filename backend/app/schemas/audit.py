from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class AuditLogResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    actor_id: uuid.UUID
    action: str
    target_user_id: uuid.UUID | None = None
    old_role: str | None = None
    new_role: str | None = None
    audit_metadata: dict[str, Any] = {}
    created_at: datetime
