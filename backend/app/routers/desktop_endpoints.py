"""story #4801 (E-INFRA-DIET ⑦-앱) — the addresses a desktop device's agents should use NOW.

- GET /api/v2/desktop/endpoints — a device's own agent key (the one the app keeps for that agent): `{api_url, mcp_url}`, the same two
  addresses a setup's confirmation hands out (`desktop_setup.exchange_urls`). Not a secret — and nothing of the key, the org or the setup in it.

Why: the app keeps each agent's two addresses from the day it was set up. When the server's address moves (a new host, a customer who
self-hosts and changes its domain) those stored addresses are stale and the agent keeps calling the old one until a new setup. The app reads
this on each connect (while the old address still answers) and writes the new one beside the same key. A key that is not a device's: 404 — the
same answer as `/desktop/remote-control` gives, so a person's session or another kind of key learns nothing.

- GET /api/v2/desktop/relay/endpoints — the same two addresses for a setup's RELAY record, asked with its own device token. The relay record is kept by the
  app per setup (device-tokens/{setupId}.bin) and goes to the daemon on every connect; it must not depend on one of the setup's agents still being alive to
  hear a move (a setup whose agents are all dead has a relay record that nobody else would move). Deliberately NOT behind the org's «원격 제어» switch
    (`/relay/setup` is: 409 while off): a record of an organization that has it off keeps knocking at its stored address (409 again and again) and, when
    the switch is turned on, would reconnect to an address that is gone. The addresses are not secrets; the answer is only given to a live device token.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.services.desktop_setup import exchange_urls

router = APIRouter(tags=["desktop-endpoints"])


class DeviceEndpoints(BaseModel):
    # None = the deployment did not set one (exchange_urls never falls back to localhost): the app keeps what it has
    api_url: str | None
    mcp_url: str | None


@router.get("/api/v2/desktop/endpoints", response_model=DeviceEndpoints)
async def get_device_endpoints(db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user)):
    from app.models.api_key import ApiKey
    from app.models.desktop_setup import DesktopSetup

    key_id = (auth.claims.get("app_metadata") or {}).get("api_key_id")
    setup_id = None
    if key_id:
        setup_id = (await db.execute(
            select(DesktopSetup.id).join(ApiKey, ApiKey.desktop_setup_id == DesktopSetup.id).where(
                ApiKey.id == uuid.UUID(str(key_id)), ApiKey.revoked_at.is_(None), DesktopSetup.revoked_at.is_(None),
            )
        )).scalar_one_or_none()
    if setup_id is None:
        raise HTTPException(status_code=404, detail={"code": "setup_not_found", "message": "this key is not a device's"})
    api_url, mcp_url = exchange_urls()
    return DeviceEndpoints(api_url=api_url, mcp_url=mcp_url)


@router.get("/api/v2/desktop/relay/endpoints", response_model=DeviceEndpoints)
async def get_relay_endpoints(
    db: AsyncSession = Depends(get_db),
    x_desktop_device_token: str | None = Header(default=None, alias="x-desktop-device-token"),
):
    from app.services import desktop_relay as relay

    # a valid, live device token only (revoked · disconnected · closed confirmer → None) — and NOT the remote-control switch (see the module note)
    if await relay.device_for_token(db, x_desktop_device_token) is None:
        raise HTTPException(status_code=401, detail={"code": "DEVICE_TOKEN_INVALID", "message": "a valid device token is required"})
    api_url, mcp_url = exchange_urls()
    return DeviceEndpoints(api_url=api_url, mcp_url=mcp_url)
