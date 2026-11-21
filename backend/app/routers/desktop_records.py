"""story 4977 B2 (alembic 0493 · design ② §4-1b) — the person's history kept as SEALED records the server cannot open.

- PUT    /api/v2/desktop/computers/{setup_id}/records       — a phone of the person's writes one record: {phone_key_id, envelope} → 201 {id, seq, replaced}
- GET    /api/v2/desktop/computers/{setup_id}/records       — ?phone_key_id & conversation_id & after & limit: the records of that computer in that conversation, oldest first, as they were kept
- DELETE /api/v2/desktop/records                            — ?conversation_id [& record_id]: the person deletes their own records of one conversation (one, or all) → {deleted}

(The computer's own write is `PUT /api/v2/desktop/relay/records` in desktop_relay.) A person's own session only: an API key or an agent key 403. Who may — the person who paired the computer, who can read the
conversation, with a phone of theirs paired with that computer at this moment (a phone taken off is refused at once: 409 `phone_not_paired`) — is judged here and in services.session_records. The body is read and
judged in the service, so no refusal (and no log, no error report) carries what it held. Nothing here is searched, indexed, notified or announced.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.desktop_setup import DesktopSetup
from app.routers.desktop_commands import _error, _person
from app.services import session_records
from app.services.desktop_relay import DesktopRelayError

router = APIRouter(prefix="/api/v2/desktop", tags=["session-records"])

_NO_STORE = {"Cache-Control": "no-store"}


async def _read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > session_records.BODY_MAX:
        raise DesktopRelayError(413, "record_too_large", "the record is larger than the server takes")
    raw = b""
    async for chunk in request.stream():  # never more than the limit is held, whatever the header said
        raw += chunk
        if len(raw) > session_records.BODY_MAX:
            raise DesktopRelayError(413, "record_too_large", "the record is larger than the server takes")
    return raw


async def _gate(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, setup_id: uuid.UUID, *, phone_key_id: uuid.UUID, member) -> DesktopSetup:
    """the computer is the person's (one answer for «no such computer» and «not yours») and the phone is paired with it NOW (a share lock until the commit: a removal that comes meanwhile waits)"""
    from app.services.agent_permissions import paired_phone
    from app.services.desktop_changes import may_read
    from app.services.desktop_commands import org_role

    user_id = uuid.UUID(str(auth.user_id))
    # the computer's row is share-locked until the commit and judged AFTER the lock: a disconnect (it updates that row) that comes meanwhile waits for this call; one that committed before is seen
    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id).with_for_update(read=True).execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if setup is None or not may_read(setup, user_id) or await org_role(db, org_id, user_id) is None:
        raise DesktopRelayError(403, "not_allowed_to_use_records", "only the person who paired this computer can use its records")
    if await paired_phone(db, member_id=uuid.UUID(str(member.id)), phone_id=phone_key_id, setup_id=setup.id, lock=True) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    return setup


async def _can_read(conversation_id: uuid.UUID, db: AsyncSession, auth: AuthContext, org_id: uuid.UUID) -> None:
    from app.routers.conversations import _can_read_conversation

    if not await _can_read_conversation(conversation_id, db, auth, org_id):
        raise DesktopRelayError(404, "record_conversation_not_found", "no such conversation")  # one answer for «no such room» and «not yours»


@router.put("/computers/{setup_id}/records")
async def put_record(
    setup_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    try:
        body = session_records.parse_phone_write(await _read_body(request))
        setup = await _gate(db, auth, org_id, setup_id, phone_key_id=body.phone_key_id, member=member)
        await _can_read(uuid.UUID(body.envelope["rec"]["conversation_id"]), db, auth, org_id)
        out = await session_records.write(db, setup, body.envelope)
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return JSONResponse(status_code=201 if not out["replaced"] else 200, content=out, headers=_NO_STORE)


@router.get("/computers/{setup_id}/records")
async def get_records(
    setup_id: uuid.UUID,
    phone_key_id: uuid.UUID = Query(),
    conversation_id: uuid.UUID = Query(),
    after: int = Query(default=0, ge=0, le=2**62),
    limit: int = Query(default=session_records.PAGE_DEFAULT, ge=1, le=session_records.PAGE_MAX),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    member = await _person(db, auth, org_id, interactive=True)
    try:
        setup = await _gate(db, auth, org_id, setup_id, phone_key_id=phone_key_id, member=member)
        await _can_read(conversation_id, db, auth, org_id)
        out = await session_records.list_records(db, setup, conversation_id=conversation_id, after=after, limit=limit)
    except DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return JSONResponse(status_code=200, content=out, headers=_NO_STORE)


@router.delete("/records")
async def delete_records(
    conversation_id: uuid.UUID = Query(),
    record_id: str | None = Query(default=None, min_length=1, max_length=256),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """The person deletes what is theirs. No phone is needed (the history is theirs to remove even when every phone is gone); the conversation must be one they can read."""
    await _person(db, auth, org_id, interactive=True)
    user_id = uuid.UUID(str(auth.user_id))
    try:
        await _can_read(conversation_id, db, auth, org_id)
    except DesktopRelayError as exc:
        return _error(exc)
    gone = await session_records.delete_records(db, org_id=org_id, user_id=user_id, conversation_id=conversation_id, record_id=record_id)
    await db.commit()
    return JSONResponse(status_code=200, content={"deleted": gone}, headers=_NO_STORE)
