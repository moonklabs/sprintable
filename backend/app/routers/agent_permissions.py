"""story #4533 (E-DESKTOP-2 B-2) — the person's side of an agent's permission request and of the phones that answer it.
Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §9 ② ③ · §10 ① ③ ④ (02d2cf71 v1.7).

- GET    /api/v2/agent-permission-requests                 — the requests sent to me (the web shows them, never answers)
- POST   /api/v2/agent-permission-requests/{id}/answer     — the phone's signed decision, carried down as it is
- POST   /api/v2/remote-devices                            — the phone registers its key (three a person)
- GET    /api/v2/remote-devices                            — my phones and what each is paired with (`?scope=org`: owner/admin)
- DELETE /api/v2/remote-devices/{id}/pairs/{setup_id}      — [빼기]: at once here, sent down to the device until it drops it

Answering and registering a phone are a person's own session (an agent key · a person's own API key: 403) — a key held by a
script must not answer for, or add a phone of, a person.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.services import agent_permissions
from app.services.desktop_relay import DesktopRelayError
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2", tags=["agent-permissions"])


def _error(exc: DesktopRelayError) -> JSONResponse:
    error = {"code": exc.code, "message": exc.message, **({"detail": exc.detail} if exc.detail else {})}
    return JSONResponse(status_code=exc.status, content={"data": None, "error": error, "meta": None})


async def _person(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, *, interactive: bool):
    """A person of the org; `interactive`: their own session at a browser or the phone app, not an API key."""
    if interactive:
        from app.routers.auth import _requires_interactive_session

        if _requires_interactive_session(auth):
            raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    member = await resolve_member(auth, org_id, db)
    if member.type != "human":
        raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    return member


@router.get("/agent-permission-requests")
async def get_permission_requests(
    state: Literal["pending", "answered", "withdrawn", "expired", "rejected"] | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=False)
    return {"requests": await agent_permissions.list_for_member(db, member_id=uuid.UUID(str(member.id)), org_id=org_id, state=state)}


@router.post("/agent-permission-requests/{request_pk}/answer")
async def post_permission_answer(
    request_pk: uuid.UUID,
    body: agent_permissions.Answer,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    try:
        row = await agent_permissions.answer_request(db, member_id=uuid.UUID(str(member.id)), org_id=org_id, request_pk=request_pk, body=body)
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return {"id": str(row.id), "state": row.state}


@router.post("/remote-devices")
async def post_remote_device(
    body: agent_permissions.RemoteDeviceRegistration,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    try:
        view, created = await agent_permissions.register_phone(db, member_id=uuid.UUID(str(member.id)), org_id=org_id, body=body)
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return JSONResponse(status_code=201 if created else 200, content=view)


@router.get("/remote-devices")
async def get_remote_devices(
    scope: Literal["mine", "org"] = Query(default="mine"),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=False)
    if scope == "org":
        if member.role not in ("owner", "admin"):
            raise HTTPException(status_code=403, detail={"code": "not_org_admin", "message": "owners and admins only"})
        return {"devices": await agent_permissions.list_phones(db, member_id=None, org_id=org_id)}
    return {"devices": await agent_permissions.list_phones(db, member_id=uuid.UUID(str(member.id)), org_id=org_id)}


@router.delete("/remote-devices/{phone_id}/pairs/{setup_id}")
async def delete_remote_device_pair(
    phone_id: uuid.UUID,
    setup_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=False)
    try:
        removed = await agent_permissions.remove_pair(
            db, phone_id=phone_id, setup_id=setup_id, actor_member_id=uuid.UUID(str(member.id)),
            actor_is_admin=member.role in ("owner", "admin"), org_id=org_id,
        )
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return {"removed": removed}
