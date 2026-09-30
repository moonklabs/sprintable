from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class InvitePreviewProject(BaseModel):
    """초대 수락 시 부여될 프로젝트 (이름 표시용)."""
    id: str
    name: str


class InvitePreviewResponse(BaseModel):
    """token으로 초대 정보 공개 조회 — 미인증 사용자도 접근 가능."""
    org_name: str
    role: str
    status: str  # pending / accepted / expired / revoked
    expires_at: datetime
    email: str  # 초대 대상 email (마스킹은 프론트에서)
    # 정책B surface②: 수락 시 접근권 부여될 프로젝트 목록(invitee는 org 접근 전이라 FE resolve 불가)
    projects: list[InvitePreviewProject] = []


class AcceptInviteRequest(BaseModel):
    token: str


class AcceptInviteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    ok: bool
    org_id: str
    role: str


class MyInvite(BaseModel):
    """story #4427 (PO 01:21Z) — a pending invite to the signed-in person's own verified email. No token: accepting stays
    the mail link (invite_accept.accept)."""
    invite_id: str
    org_id: str
    org_name: str
    role: str
    invited_at: datetime
    expires_at: datetime


class MyInvitesResponse(BaseModel):
    invites: list[MyInvite]
