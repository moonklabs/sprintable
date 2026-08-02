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
