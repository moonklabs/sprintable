from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class CreateOrgInvite(BaseModel):
    email: str
    # story 5021: only the three organization roles (schemas/org_member.ORG_ROLES — a test holds the two together); anything else is 422, never stored
    role: Literal["owner", "admin", "member"] = "member"
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
    # story 5023 (e): True when this link's address is a name only the server computer itself knows (a workspace server before its public address is set: `localhost`) — the screen says so beside the link
    link_is_local: bool = False
