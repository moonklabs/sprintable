from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID | None = None
    name: str
    email: str | None = None  # E-ONBOARDING S2: User.email 노출
    type: str
    role: str
    is_active: bool
    project_name: str | None = None
    has_password: bool | None = None


class UpdateMe(BaseModel):
    name: str
