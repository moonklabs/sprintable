import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

ORG_ROLES = ("owner", "admin", "member")


class OrgMemberCreate(BaseModel):
    org_id: uuid.UUID
    user_id: uuid.UUID
    role: str = "member"


class OrgMemberUpdate(BaseModel):
    role: str | None = None


class OrgMemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    created_at: datetime
    deleted_at: datetime | None = None
