"""story #4536 (E-DESKTOP-2 C-2) — an agent's watches: set · list · clear. An agent key only, its own watches only (another
agent's watch is «not found», in the same org too). See services.agent_watches."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.services import agent_watches as svc

router = APIRouter(prefix="/api/v2/watches", tags=["watches"])


def _agent(auth: AuthContext) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """(agent member id, org id, project id) of an agent key — a person's login has no watches here."""
    meta = auth.claims.get("app_metadata", {}) or {}
    if not meta.get("api_key_id"):
        raise HTTPException(status_code=403, detail={"code": "AGENT_KEY_REQUIRED", "message": "watches belong to agents"})
    if not meta.get("org_id") or not meta.get("project_id"):
        raise HTTPException(status_code=422, detail={"code": "NO_PROJECT", "message": "the agent key has no project to deliver to"})
    return uuid.UUID(auth.user_id), uuid.UUID(meta["org_id"]), uuid.UUID(meta["project_id"])


def _error(exc: svc.WatchError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"data": None, "error": {"code": exc.code, "message": exc.message}, "meta": None})


@router.post("", status_code=201)
async def set_watch(body: svc.WatchCreate, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user)):
    agent_id, org_id, project_id = _agent(auth)
    try:
        watch = await svc.create_watch(db, org_id=org_id, project_id=project_id, agent_member_id=agent_id, body=body)
    except svc.WatchError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return svc.watch_view(watch)


@router.get("")
async def list_watches(
    include_done: bool = Query(False), db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user),
):
    agent_id, _org, _project = _agent(auth)
    return {"watches": [svc.watch_view(w) for w in await svc.list_watches(db, agent_id, include_done=include_done)]}


@router.delete("/{watch_id}")
async def clear_watch(watch_id: uuid.UUID, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user)):
    agent_id, _org, _project = _agent(auth)
    try:
        watch = await svc.cancel_watch(db, agent_id, watch_id)
    except svc.WatchError as exc:
        await db.rollback()
        return _error(exc)
    await db.commit()
    return svc.watch_view(watch)
