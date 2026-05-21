from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class InvitePreviewResponse(BaseModel):
    """token으로 초대 정보 공개 조회 — 미인증 사용자도 접근 가능."""
    org_name: str
    role: str
    status: str  # pending / accepted / expired / revoked
    expires_at: datetime
    email: str  # 초대 대상 email (마스킹은 프론트에서)


class AcceptInviteRequest(BaseModel):
    token: str


class AcceptInviteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    ok: bool
    org_id: str
    role: str
