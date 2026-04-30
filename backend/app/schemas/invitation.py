from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CreateInvitation(BaseModel):
    email: str
    role: str = "member"
    invited_by: uuid.UUID
    project_id: uuid.UUID | None = None


class InvitationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None = None
    invited_by: uuid.UUID
    email: str
    role: str
    status: str
    expires_at: datetime
    accepted_at: datetime | None = None
    created_at: datetime


class AcceptInvitation(BaseModel):
    token: str
