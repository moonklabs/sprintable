from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CreateUserBlock(BaseModel):
    blocked_member_id: uuid.UUID


class UserBlockResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    blocker_member_id: uuid.UUID
    blocked_member_id: uuid.UUID
    created_at: datetime
    # story #4444 — the list's name for the blocked person (this org only · null when none · never an email). Create answers
    # leave it out.
    blocked_member_name: str | None = None
