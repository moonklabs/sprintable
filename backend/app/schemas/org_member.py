import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from app.schemas.not_null_fields import RejectsExplicitNull

ORG_ROLES = ("owner", "admin", "member")


class OrgMemberCreate(BaseModel):
    org_id: uuid.UUID
    user_id: uuid.UUID
    role: str = "member"


class OrgMemberUpdate(RejectsExplicitNull):
    # story #4337 — DB 칸이 NOT NULL인 필드: 생략 = 그대로 · 명시 null은 422(예전엔 저장에서 무결성 오류 500).
    NOT_NULL_FIELDS = frozenset({"role"})

    role: str | None = None


class OrgMemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    created_at: datetime
    deleted_at: datetime | None = None
    email: str | None = None
    name: str | None = None  # E-ONBOARDING S2: 실명(canonical Member.name → display_name, story #3758부터 email 폴백 0)
    # story 5023 (d): the caller may hand THIS person a password-reset link (a server host, the caller an owner, the person eligible — `services/owner_password_reset.eligible`). False everywhere else (hosted · the desktop app · every list but the owner's)
    password_reset_link_available: bool = False


class PasswordResetLinkResponse(BaseModel):
    """story 5023 (d): the link the owner hands over; it is a secret for its 30 minutes (whoever opens it sets the person's password) — never stored, never logged"""

    reset_url: str
    expires_in_seconds: int
