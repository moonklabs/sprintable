"""story 5041 (C0b) — the card of an agent's ask: read it, press it.

`POST /api/v2/agent-actions/{id}/decision` is a PERSON'S SESSION only (no API key of any kind, no agent): approving makes the server run the stored call with the presser's own
credentials (see `app/services/agent_action.py`). The words here are codes — the card's sentences are the web's (and the server's catalogue for the chat line).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.models.hitl import HitlRequest
from app.services import agent_action as svc
from app.services.member_resolver import lookup_members_by_ids, resolve_member
from app.services.project_auth import has_project_access

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/agent-actions", tags=["agent-actions", "Work"])


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]


def _state(req: HitlRequest) -> str:
    """pending | approved(running) | executed | failed | rejected | expired"""
    execution = (req.hitl_metadata or {}).get("execution") or {}
    if req.status == "pending":
        return "expired" if svc.is_expired(req) else "pending"
    if req.status == "rejected":
        return "expired" if (req.response_text or "") == "expired" else "rejected"
    if req.status == "approved":
        s = execution.get("state")
        return s if s in ("running", "executed", "failed") else "running"
    return req.status


async def _person(auth: AuthContext, org_id: uuid.UUID, session: AsyncSession):
    if (auth.claims.get("app_metadata") or {}).get("api_key_id"):
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_PERSON_SESSION_REQUIRED", "message": "AGENT_ACTION_PERSON_SESSION_REQUIRED"})
    who = await resolve_member(auth, org_id, session)
    if who.type != "human":
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_PERSON_SESSION_REQUIRED", "message": "AGENT_ACTION_PERSON_SESSION_REQUIRED"})
    return who


async def _load(session: AsyncSession, auth: AuthContext, org_id: uuid.UUID, request_id: uuid.UUID) -> HitlRequest:
    req = (await session.execute(
        select(HitlRequest).where(HitlRequest.id == request_id, HitlRequest.org_id == org_id, HitlRequest.request_type == svc.REQUEST_TYPE, HitlRequest.deleted_at.is_(None))
        # the state moves through raw UPDATEs (claim · finish): a copy this session already holds must be re-read, never trusted
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    # not there and not yours look the same — nobody learns which asks exist in a project they cannot see
    if req is None or not await has_project_access(session, uuid.UUID(auth.user_id), req.project_id, org_id):
        raise HTTPException(status_code=404, detail={"code": "AGENT_ACTION_NOT_FOUND", "message": "AGENT_ACTION_NOT_FOUND"})
    return req


async def _view(session: AsyncSession, req: HitlRequest) -> dict:
    meta = req.hitl_metadata or {}
    execution = meta.get("execution") or {}
    ids = {i for i in (req.agent_id, req.responded_by) if i is not None}
    names = await lookup_members_by_ids(ids, session) if ids else {}
    return {
        "id": str(req.id),
        "state": _state(req),
        "action_key": meta.get("action_key"),
        "title": req.title,
        "prompt": req.prompt,
        "project_id": str(req.project_id),
        "requested_by": {"id": str(req.agent_id), "name": (names.get(req.agent_id).name if names.get(req.agent_id) else None)},
        "decided_by": ({"id": str(req.responded_by), "name": (names.get(req.responded_by).name if names.get(req.responded_by) else None)} if req.responded_by else None),
        "decided_at": req.responded_at.isoformat() if req.responded_at else None,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "execution": {k: execution.get(k) for k in ("state", "http_status", "reason")} if execution else None,
    }


@router.get("/{request_id}")
async def get_agent_action(
    request_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    await _person(auth, org_id, session)
    return await _view(session, await _load(session, auth, org_id, request_id))


@router.post("/{request_id}/decision")
async def decide_agent_action(
    request_id: uuid.UUID,
    body: DecisionBody,
    request: Request,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    presser = await _person(auth, org_id, session)
    req = await _load(session, auth, org_id, request_id)
    rid, snap, action_key = req.id, dict((req.hitl_metadata or {}).get("snapshot") or {}), (req.hitl_metadata or {}).get("action_key", "")

    if svc.is_expired(req):
        closed = await session.execute(
            text(
                "UPDATE agent_hitl_requests SET status = 'rejected', response_text = 'expired', responded_at = now() "
                "WHERE id = :id AND status = 'pending' AND expires_at <= now()"
            ),
            {"id": rid},
        )
        if (closed.rowcount or 0) == 1:
            await session.refresh(req)
            await svc.notify_agent(session, req=req, presser=presser, kind="expired")
        await session.commit()
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_EXPIRED", "message": "AGENT_ACTION_EXPIRED"})

    if body.decision == "reject":
        res = await session.execute(
            text("UPDATE agent_hitl_requests SET status = 'rejected', responded_by = :who, responded_at = now() WHERE id = :id AND status = 'pending' AND deleted_at IS NULL"),
            {"who": presser.id, "id": rid},
        )
        if (res.rowcount or 0) != 1:
            raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_ALREADY_DECIDED", "message": "AGENT_ACTION_ALREADY_DECIDED"})
        await session.refresh(req)
        await svc.notify_agent(session, req=req, presser=presser, kind="rejected")
        await session.commit()
        return await _view(session, await _load(session, auth, org_id, rid))

    # approve ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    if not svc.snapshot_is_sound(action_key, snap):
        logger.error("agent_action snapshot unsound request=%s action=%s", rid, action_key)
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_SNAPSHOT_INVALID", "message": "AGENT_ACTION_SNAPSHOT_INVALID"})
    if not await svc._claim(session, request_id=rid, org_id=org_id, presser_id=presser.id):
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_ALREADY_DECIDED", "message": "AGENT_ACTION_ALREADY_DECIDED"})
    await session.commit()  # the claim is visible to everyone before the call starts — a second press loses here, not after

    try:
        resp = await svc.execute_as_presser(request, snap, request_id=rid)
    except Exception as exc:  # noqa: BLE001 — the call itself blew up: close the request as failed (nothing is retried)
        logger.error("agent_action execution raised request=%s", rid, exc_info=True)
        await svc._finish(session, request_id=rid, execution={"state": "failed", "reason": type(exc).__name__, "at": datetime.now(timezone.utc).isoformat()})
        await session.commit()
        req = await _load(session, auth, org_id, rid)
        await svc.notify_agent(session, req=req, presser=presser, kind="failed", reason=type(exc).__name__)
        await session.commit()
        return await _view(session, req)

    if resp.status_code == 403:
        # this person may not do it: it goes back, untouched, for the next one — and says why in one line
        await svc._unclaim(session, request_id=rid)
        await session.commit()
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_FORBIDDEN_FOR_APPROVER", "message": "this person may not do it", "reason": svc._reason_of(resp)})

    now = datetime.now(timezone.utc).isoformat()
    if 200 <= resp.status_code < 300:
        await svc._finish(session, request_id=rid, execution={"state": "executed", "http_status": resp.status_code, "at": now})
        kind, reason = "approved", ""
    else:
        reason = svc._reason_of(resp)
        await svc._finish(session, request_id=rid, execution={"state": "failed", "http_status": resp.status_code, "reason": reason, "at": now})
        kind = "changed" if resp.status_code in (404, 409, 410, 422) else "failed"
    await session.commit()
    req = await _load(session, auth, org_id, rid)
    await svc.notify_agent(session, req=req, presser=presser, kind=kind, reason=reason)
    await session.commit()
    return await _view(session, req)
