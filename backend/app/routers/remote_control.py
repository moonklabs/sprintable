"""story #4535 (E-DESKTOP-2 B-4 · AC1) — an organization's «원격 제어» switch (services.remote_control).

- GET  /api/v2/organizations/{org_id}/remote-control — a person of that org: the state, and whether they may change it
- PUT  /api/v2/organizations/{org_id}/remote-control — an owner only (an admin · an agent key: 403 · another org: 404)
- GET  /api/v2/desktop/remote-control — a device's own agent key: the state of its org (the app's chip · the relay's floor)
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.organization import Organization
from app.services import remote_control
from app.services.member_resolver import resolve_member

router = APIRouter(tags=["remote-control"])


class RemoteControlState(BaseModel):
    enabled: bool
    enabled_at: str | None
    can_change: bool


class RemoteControlChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class DeviceRemoteControl(BaseModel):
    enabled: bool


async def _person_of(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """A person of the org (an agent key: 403). Not a member: resolve_member's own 404."""
    member = await resolve_member(auth, org_id, db)
    if member.type != "human":
        raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    return member


async def _org(db: AsyncSession, org_id: uuid.UUID, *, lock: bool = False) -> Organization:
    q = select(Organization).where(Organization.id == org_id)
    org = (await db.execute(q.with_for_update() if lock else q)).scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "organization not found"})
    return org


@router.get("/api/v2/organizations/{org_id}/remote-control", response_model=RemoteControlState)
async def get_remote_control(org_id: uuid.UUID, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user)):
    member = await _person_of(db, auth, org_id)
    return remote_control.state_view(await _org(db, org_id), can_change=member.role == "owner")


@router.put("/api/v2/organizations/{org_id}/remote-control", response_model=RemoteControlState)
async def put_remote_control(
    org_id: uuid.UUID, body: RemoteControlChange, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user),
):
    member = await _person_of(db, auth, org_id)
    if member.role != "owner":
        raise HTTPException(status_code=403, detail={"code": "owner_required", "message": "only an owner of this organization can change it"})
    org = await _org(db, org_id, lock=True)
    await remote_control.set_enabled(db, org=org, actor_id=member.id, enabled=body.enabled)
    await db.commit()
    return remote_control.state_view(org, can_change=True)


@router.get("/api/v2/desktop/remote-control", response_model=DeviceRemoteControl)
async def get_device_remote_control(db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user)):
    """The state of the org of the device this agent key belongs to (a key that is not a device's: 404 — nothing to say)."""
    from app.models.api_key import ApiKey
    from app.models.desktop_setup import DesktopSetup

    key_id = (auth.claims.get("app_metadata") or {}).get("api_key_id")
    org_id = None
    if key_id:
        org_id = (await db.execute(
            select(DesktopSetup.org_id).join(ApiKey, ApiKey.desktop_setup_id == DesktopSetup.id).where(
                ApiKey.id == uuid.UUID(str(key_id)), ApiKey.revoked_at.is_(None), DesktopSetup.revoked_at.is_(None),
            )
        )).scalar_one_or_none()
    if org_id is None:
        raise HTTPException(status_code=404, detail={"code": "setup_not_found", "message": "this key is not a device's"})
    return DeviceRemoteControl(enabled=await remote_control.is_enabled(db, org_id))
