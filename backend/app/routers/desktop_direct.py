"""story 4993 (P2 · same-network direct) — a paired phone's ASK for a short-lived direct door on its own computer, from the phone or the web, and the computer's SEALED answer. Both ways carry envelopes the server cannot open
(contract: contracts/direct-negotiation.json, the same bytes as the mobile repository's).

- POST /api/v2/desktop/computers/{setup_id}/direct                 — the person who paired the computer asks: {idempotency_key, phone_key_id, envelope} → 201 {command_id, expires_at}
- GET  /api/v2/desktop/computers/{setup_id}/direct/{command_id}    — the sealed answer, once (or where the ask stands), for that person only: 404 `direct_ask_not_found` for every reason
- DELETE /api/v2/desktop/computers/{setup_id}/direct/{command_id}  — the person gives the ask up (the screen closed): its row goes now

(The computer's own PUT of its answer is `PUT /api/v2/desktop/relay/direct/{command_id}` in desktop_relay.) A person's own session only: an API key or an agent key 403. Who may ask — the computer's pairing person, with a phone of theirs
paired with it — is judged in services.desktop_direct. The same road as the files request (routers/desktop_files.py), with the project taken out.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.routers.desktop_commands import _error, _person
from app.services import desktop_direct
from app.services.desktop_relay import DesktopRelayError

router = APIRouter(prefix="/api/v2/desktop", tags=["desktop-direct"])


@router.post("/computers/{setup_id}/direct")
async def post_desktop_direct(
    setup_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    user_id = uuid.UUID(str(auth.user_id))
    try:
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > desktop_direct.ASK_BODY_MAX:
            raise DesktopRelayError(413, "direct_request_too_large", "the request is larger than the server takes")
        raw = b""
        async for chunk in request.stream():  # never more than the limit is held, whatever the header said
            raw += chunk
            if len(raw) > desktop_direct.ASK_BODY_MAX:
                raise DesktopRelayError(413, "direct_request_too_large", "the request is larger than the server takes")
        body = desktop_direct.parse_ask(raw)
        command_id, expires_at = await desktop_direct.create_ask(db, member_id=uuid.UUID(str(member.id)), user_id=user_id, org_id=org_id, setup_id=setup_id, body=body)
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return JSONResponse(status_code=201, content={"command_id": str(command_id), "expires_at": expires_at.isoformat()}, headers={"Cache-Control": "no-store"})


@router.get("/computers/{setup_id}/direct/{command_id}")
async def get_desktop_direct(
    setup_id: uuid.UUID,
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """The sealed answer, once: reading deletes it. 404 `direct_ask_not_found` for every reason (not yours · not this computer's · expired · already read)."""
    await _person(db, auth, org_id, interactive=True)
    user_id = uuid.UUID(str(auth.user_id))
    try:
        out = await desktop_direct.read_answer(db, user_id=user_id, org_id=org_id, setup_id=setup_id, command_id=command_id)
    except DesktopRelayError as exc:
        await db.commit()  # what the refusal deleted (an expired or no-longer-allowed row) stays deleted
        return _error(exc)
    await db.commit()
    return JSONResponse(status_code=200, content=out, headers={"Cache-Control": "no-store"})


@router.delete("/computers/{setup_id}/direct/{command_id}")
async def delete_desktop_direct(
    setup_id: uuid.UUID,
    command_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """The person gives the ask up: the row goes now. Only the asker's own row — any other id deletes nothing, and says so the same way (`deleted: false`)."""
    await _person(db, auth, org_id, interactive=True)
    user_id = uuid.UUID(str(auth.user_id))
    gone = await desktop_direct.finish_ask(db, user_id=user_id, setup_id=setup_id, command_id=command_id)
    await db.commit()
    return JSONResponse(status_code=200, content={"deleted": gone}, headers={"Cache-Control": "no-store"})
