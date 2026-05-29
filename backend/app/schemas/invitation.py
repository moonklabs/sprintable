from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


class CreateInvitation(BaseModel):
    email: str
    role: str = "member"
    invited_by: uuid.UUID
    project_id: uuid.UUID | None = None

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Invalid email format")
        return v


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
    email_sent_at: datetime | None = None
    email_error: str | None = None
    invite_url: str | None = None


class InvitationPreviewResponse(BaseModel):
    org_name: str
    org_id: uuid.UUID
    email: str
    role: str
    status: str
    expires_at: datetime


class AcceptInvitation(BaseModel):
    token: str
