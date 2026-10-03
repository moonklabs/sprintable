"""story #4529 (E-DESKTOP-2 B-1) — the device relay: one outward connection per device (SSE down · POST up). Contract: doc
«E-DESKTOP-2 B-1 — 기기 줄 계약 v1» (02d2cf71).

Authenticated by the device token alone (`x-desktop-device-token`): an agent key or a person's token is no device here (401),
and the device token is no identity anywhere else (no other dependency reads that header). Nothing up carries terminal bytes,
prompt text, a path or a key — every body forbids extra fields.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_factory
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.desktop_setup import DesktopSetup
from app.services import desktop_relay as relay
from app.services.desktop_relay import SESSION_KEY_PATTERN

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/desktop", tags=["desktop"])

_LIFESPAN_SEC = 300  # closed before Cloud Run's request timeout; the daemon reconnects from its last id
_LIFESPAN_JITTER_SEC = 30
_HEARTBEAT_SEC = 30
_RECHECK_SEC = 30
_BACKSTOP_SEC = 30  # a read even without a wake (a wake lost on the way) — new commands come by the wake (PO 05:43Z)
_STREAMS_PER_DEVICE = 2  # a reconnect may overlap the old connection for a moment


def _error(exc: relay.DesktopRelayError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"data": None, "error": {"code": exc.code, "message": exc.message}, "meta": None})


async def _device(
    db: AsyncSession = Depends(get_db),
    x_desktop_device_token: str | None = Header(default=None, alias="x-desktop-device-token"),
) -> DesktopSetup:
    setup = await relay.device_for_token(db, x_desktop_device_token)
    if setup is None:
        raise HTTPException(status_code=401, detail={"code": "DEVICE_TOKEN_INVALID", "message": "a valid device token is required"})
    return setup


@router.get("/relay/stream")
async def device_stream(request: Request, setup: DesktopSetup = Depends(_device), db: AsyncSession = Depends(get_db)) -> StreamingResponse:
    setup_id = setup.id
    try:
        start_seq = int(request.headers.get("last-event-id") or 0)
    except ValueError:
        start_seq = 0
    await relay.touch_device(db, setup_id)
    await db.commit()

    from app.services import sse_lease

    conn_id = str(uuid.uuid4())
    scope = f"desktop:{setup_id}"
    from app.routers.events import _agent_connections

    # Qadir 07:19Z — with the Redis lease off (its default) acquire answers None, not False: the per-device limit then counts
    # this instance's open streams, as the agent stream does (agent_gateway.py). Read with .get(…, ()) — a refusal never
    # creates the map key (#2602: a refusal must not make the resource).
    lease = await sse_lease.acquire(scope, _STREAMS_PER_DEVICE, conn_id)
    if lease is False or (lease is None and len(_agent_connections.get(relay.wake_key(setup_id), ())) >= _STREAMS_PER_DEVICE):
        raise HTTPException(status_code=429, detail={"code": "DEVICE_STREAM_LIMITED", "message": "this device already has its connections"})

    wakes: asyncio.Queue[dict] = asyncio.Queue(maxsize=50)
    _agent_connections[relay.wake_key(setup_id)].add(wakes)  # the agent stream's wake reaches it (services.desktop_relay)
    deadline = time.monotonic() + _LIFESPAN_SEC + random.uniform(0, _LIFESPAN_JITTER_SEC)

    async def generate():
        last_seq = start_seq
        last_beat = last_check = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    return
                now = time.monotonic()
                if now >= deadline:
                    yield "event: lifespan_reconnect\ndata: {}\n\n"
                    return
                async with async_session_factory() as s:
                    if now - last_check >= _RECHECK_SEC:
                        last_check = now
                        if not await relay.device_still_valid(s, setup_id):
                            yield f"event: access_revoked\ndata: {json.dumps({'reason': 'device_disconnected'})}\n\n"
                            return
                    commands = await relay.commands_to_send(s, setup_id, last_seq)
                    if now - last_beat >= _HEARTBEAT_SEC:
                        await relay.touch_device(s, setup_id)
                    await s.commit()
                for c in commands:
                    frame = {"command_id": str(c.id), "kind": c.kind, "session_key": c.session_key, "payload": c.payload,
                             "created_at": c.created_at.isoformat() if c.created_at else None}
                    yield f"event: command\nid: {c.device_seq}\ndata: {json.dumps(frame)}\n\n"
                    last_seq = c.device_seq
                if now - last_beat >= _HEARTBEAT_SEC:
                    last_beat = now
                    yield "event: heartbeat\ndata: {}\n\n"
                wait = max(0.05, min(_BACKSTOP_SEC, _HEARTBEAT_SEC - (time.monotonic() - last_beat), deadline - time.monotonic()))
                try:
                    await asyncio.wait_for(wakes.get(), timeout=wait)
                    while not wakes.empty():  # several wakes → one read
                        wakes.get_nowait()
                except asyncio.TimeoutError:
                    pass
        finally:
            _agent_connections[relay.wake_key(setup_id)].discard(wakes)
            await sse_lease.release(scope, conn_id)

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.put("/relay/sessions")
async def put_sessions(body: relay.SessionSnapshot, setup: DesktopSetup = Depends(_device), db: AsyncSession = Depends(get_db)):
    try:
        n = await relay.replace_sessions(db, setup, body)
    except relay.DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return {"sessions": n}


@router.post("/relay/sessions/{session_key}/state")
async def post_session_state(
    body: relay.SessionStateReport,
    session_key: str = Path(pattern=SESSION_KEY_PATTERN),
    setup: DesktopSetup = Depends(_device),
    db: AsyncSession = Depends(get_db),
):
    try:
        row = await relay.record_session_state(db, setup, session_key, body)
    except relay.DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return {"session_key": row.session_key, "state": row.state, "report_seq": row.last_report_seq}


@router.post("/relay/commands/{command_id}/result")
async def post_command_result(
    command_id: uuid.UUID, body: relay.CommandResult, setup: DesktopSetup = Depends(_device), db: AsyncSession = Depends(get_db),
):
    try:
        cmd = await relay.record_command_result(db, setup, command_id, body)
    except relay.DesktopRelayError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return {"command_id": str(cmd.id), "state": cmd.state}


@router.get("/setups/{setup_id}/sessions")
async def get_device_sessions(
    setup_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """A person's view of a device's sessions (owner/admin, as the «연결된 기기» section) — `unknown` when the device is silent."""
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(db, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail={"code": "NOT_ORG_ADMIN", "message": "owners and admins only"})
    exists = (await db.execute(
        select(DesktopSetup.id).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id)
    )).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail={"code": "SETUP_NOT_FOUND", "message": "no such device in this org"})
    return {"sessions": await relay.device_sessions_view(db, setup_id)}
