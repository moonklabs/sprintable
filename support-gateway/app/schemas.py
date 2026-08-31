from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class SessionResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    created_at: datetime


class MessageCreateRequest(BaseModel):
    content: str


class MessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    role: str
    created_at: datetime
