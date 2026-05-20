from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CreateOrgInvite(BaseModel):
    email: str
    role: str = "member"


class OrgInviteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    email: str
    role: str
    status: str
    expires_at: datetime
    accepted_at: datetime | None
    created_by: uuid.UUID | None
    created_at: datetime
    email_sent_at: datetime | None = None
    email_error: str | None = None
