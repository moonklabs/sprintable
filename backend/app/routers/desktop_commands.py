"""story #4534 (E-DESKTOP-2 B-3) — an agent's session in its DM header, and a person's signed stop / instruction from the phone.
Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §11 (02d2cf71 v1.9 · v1.9.1).

- GET  /api/v2/agents/{agent_member_id}/desktop-session                  — whoever can open the agent's DM (else 404)
- POST /api/v2/agents/{agent_member_id}/desktop-commands                 — the phone: stop_session | send_prompt | end_session (a
  person's own session — an API key or an agent key 403; who may press and the phone's pairing are checked in
  services.desktop_commands; story #4599: end_session = the whole session ended, the handle on a turn a macOS window holds)
- GET  /api/v2/agents/{agent_member_id}/desktop-commands/{command_id}    — the result line, for the person who pressed only
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.services import desktop_commands
from app.services.desktop_relay import DesktopRelayError
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/agents", tags=["desktop-commands"])


def _error(exc: DesktopRelayError) -> JSONResponse:
    error = {"code": exc.code, "message": exc.message, **({"detail": exc.detail} if exc.detail else {})}
    return JSONResponse(status_code=exc.status, content={"data": None, "error": error, "meta": None})


async def _person(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, *, interactive: bool):
    if interactive:
        from app.routers.auth import _requires_interactive_session

        if _requires_interactive_session(auth):
            raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    member = await resolve_member(auth, org_id, db)
    if member.type != "human":
        raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    return member


@router.get("/{agent_member_id}/desktop-session")
async def get_desktop_session(
    agent_member_id: uuid.UUID,
    conversation_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=False)
    user_id = uuid.UUID(str(auth.user_id))
    try:
        return await desktop_commands.session_view(
            db, member_id=uuid.UUID(str(member.id)), member_role=await desktop_commands.org_role(db, org_id, user_id), user_id=user_id,
            org_id=org_id, agent_id=agent_member_id, conversation_id=conversation_id,
        )
    except DesktopRelayError as exc:
        return _error(exc)


@router.post("/{agent_member_id}/desktop-commands")
async def post_desktop_command(
    agent_member_id: uuid.UUID,
    body: desktop_commands.CommandRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    user_id = uuid.UUID(str(auth.user_id))
    try:
        cmd, state = await desktop_commands.create_command(
            db, member_id=uuid.UUID(str(member.id)), member_role=await desktop_commands.org_role(db, org_id, user_id), user_id=user_id,
            org_id=org_id, agent_id=agent_member_id, body=body,
        )
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    if cmd is None:
        return JSONResponse(status_code=200, content={"state": state})
    return JSONResponse(status_code=201, content={"command_id": str(cmd.id), "state": state})


@router.get("/{agent_member_id}/desktop-commands/{command_id}")
async def get_desktop_command(
    agent_member_id: uuid.UUID,
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=False)
    try:
        return await desktop_commands.get_command(
            db, member_id=uuid.UUID(str(member.id)), org_id=org_id, agent_id=agent_member_id, command_id=command_id,
        )
    except DesktopRelayError as exc:
        return _error(exc)
