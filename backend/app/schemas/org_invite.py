from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class CreateOrgInvite(BaseModel):
    email: str
    role: str = "member"
    # 정책B: 초대 시 부여할 프로젝트 ids(선택). 빈 리스트 = org-only 초대.
    project_ids: list[uuid.UUID] = []


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
    project_ids: list[uuid.UUID] = []
    invite_url: str | None = None
