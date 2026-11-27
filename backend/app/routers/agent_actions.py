"""story 5041 (C0b) — the card of an agent's ask: read it, press it.

`POST /api/v2/agent-actions/{id}/decision` is a PERSON'S SESSION only (no API key of any kind, no agent): approving makes the server run the stored call with the presser's own
credentials (see `app/services/agent_action.py`). The words here are codes — the card's sentences are the web's (and the server's catalogue for the chat line).
"""
from __future__ import annotations

import logging
import re
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
    # story 5041 ② step 3 — «이번만 승인 / 이 에이전트는 이 프로젝트에서 늘 허용»: with an approval, ALSO save «always allow» for this agent × this project × this action (the same setting `PUT /agent-action-policy` makes)
    always_allow: bool = False


def _locale_of(request: Request) -> str:
    """the reader's language: the web proxy sends the screen's locale as Accept-Language (an agent's own call falls back to the default)"""
    from app.services.agent_onboarding_config import resolve_locale_from_request

    return resolve_locale_from_request(None, request.headers.get("accept-language"))


def _stale_running(req: HitlRequest) -> bool:
    """pressed, never finished: `responded_at` is the press — past `RUNNING_STALE_AFTER` the process that was running it is taken as gone"""
    started = svc._aware(req.responded_at)
    return req.status == "approved" and ((req.hitl_metadata or {}).get("execution") or {}).get("state") == "running" and started is not None \
        and started <= datetime.now(timezone.utc) - svc.RUNNING_STALE_AFTER


def _state(req: HitlRequest) -> str:
    """pending | retry (pressed once and it did not finish — pressing again continues it, never doubles it) | approved(running) | executed | failed | rejected | expired"""
    execution = (req.hitl_metadata or {}).get("execution") or {}
    if _stale_running(req):
        return "retry"
    if req.status == "pending":
        if svc.is_expired(req):
            return "expired"
        return "retry" if execution.get("reason") == "unfinished" else "pending"
    if req.status == "rejected":
        return "expired" if (req.response_text or "") == "expired" else "rejected"
    if req.status == "approved":
        s = execution.get("state")
        return s if s in ("running", "executed", "failed") else "running"
    return req.status


async def _person(auth: AuthContext, org_id: uuid.UUID, session: AsyncSession):
    # a person's SESSION only: no key of any kind — an agent's key (`api_key_id`) AND a person's own personal key (`human_api_key_id`, the `hu_live_` one: it looks like a person to `resolve_member` but it sits in
    # config files and local agents' environments — whoever can read it could approve an ask this agent made, under that person's name). Both claims are the only two key origins `get_current_user` sets.
    _meta = auth.claims.get("app_metadata") or {}
    if _meta.get("api_key_id") or _meta.get("human_api_key_id"):
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_PERSON_SESSION_REQUIRED", "message": "AGENT_ACTION_PERSON_SESSION_REQUIRED"})
    who = await resolve_member(auth, org_id, session)
    if who.type != "human":
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_PERSON_SESSION_REQUIRED", "message": "AGENT_ACTION_PERSON_SESSION_REQUIRED"})
    return who


async def _load(session: AsyncSession, auth: AuthContext, org_id: uuid.UUID, request_id: uuid.UUID, *, agent_member_id: uuid.UUID | None = None) -> HitlRequest:
    req = (await session.execute(
        select(HitlRequest).where(HitlRequest.id == request_id, HitlRequest.org_id == org_id, HitlRequest.request_type == svc.REQUEST_TYPE, HitlRequest.deleted_at.is_(None))
        # the state moves through raw UPDATEs (claim · finish): a copy this session already holds must be re-read, never trusted
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()
    # not there and not yours look the same — nobody learns which asks exist in a project they cannot see. An AGENT may read ITS OWN ask (and no other's)
    if agent_member_id is not None:
        if req is None or req.agent_id != agent_member_id:
            raise HTTPException(status_code=404, detail={"code": "AGENT_ACTION_NOT_FOUND", "message": "AGENT_ACTION_NOT_FOUND"})
        return req
    if req is None or not await has_project_access(session, uuid.UUID(auth.user_id), req.project_id, org_id):
        raise HTTPException(status_code=404, detail={"code": "AGENT_ACTION_NOT_FOUND", "message": "AGENT_ACTION_NOT_FOUND"})
    return req


# what the ask is about, read from the stored call's PATH only (never the body): the card offers «열어 보기» on it. `kind` is the entity registry's word.
_U = svc._UUID  # the one UUID shape the action patterns already use (Kadir 6012 L2: not `[0-9a-f-]{36}`, which `-` ×36 passes)
_TARGET_PATHS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("story", re.compile(rf"/api/v2/stories/(?P<id>{_U})")),
    ("task", re.compile(rf"/api/v2/tasks/(?P<id>{_U})")),
    ("epic", re.compile(rf"/api/v2/(?:goals|epics)/(?P<id>{_U})")),
    ("doc", re.compile(rf"/api/v2/docs/(?P<id>{_U})")),
    ("sprint", re.compile(rf"/api/v2/sprints/(?P<id>{_U})(?:/close)?")),
    ("artifact", re.compile(rf"/api/v2/visual-artifacts/(?P<id>{_U})/pins/{_U}")),
)


# the kind of object each action is about — a stored path that names another kind than its action does is no target (a hand-edited row cannot make the card point somewhere else)
_ACTION_KIND = {
    "story.delete": "story", "task.delete": "task", "goal.delete": "epic", "doc.delete": "doc",
    "sprint.delete": "sprint", "sprint.close": "sprint", "spec_pin.delete": "artifact",
}


def _target_of(snapshot: dict | None, action_key: str | None = None) -> dict | None:
    path = (snapshot or {}).get("path")
    if not isinstance(path, str):
        return None
    for kind, pattern in _TARGET_PATHS:
        m = pattern.fullmatch(path)  # the whole path (Kadir 6012 L1: `$` also matches before a trailing newline)
        if m:
            if _ACTION_KIND.get(action_key or "") != kind:
                return None
            return {"kind": kind, "id": m.group("id").lower()}
    return None


async def _always_allow_available(session: AsyncSession, req: HitlRequest, org_id: uuid.UUID, viewer_user_id: uuid.UUID | None) -> bool:
    """whether the card offers «always allow»: the viewer is an organisation owner / admin (a PERSON's session), the action has an auto slot, and it is not already `auto` for this agent in this project"""
    from app.services import agent_action_policy as policy
    from app.services.project_auth import is_org_owner_or_admin

    action_key = (req.hitl_metadata or {}).get("action_key", "")
    if viewer_user_id is None or action_key not in policy.adjustable_actions() or action_key in policy.NO_AUTO or action_key in policy.FLOOR_ACTIONS:
        return False
    if not await is_org_owner_or_admin(session, viewer_user_id, org_id):
        return False
    level, _ = await policy.resolve_action_level(session, org_id=req.org_id, project_id=req.project_id, agent_id=req.agent_id, action_key=action_key)
    return level != "auto"


async def _view(session: AsyncSession, req: HitlRequest, locale: str = "ko", *, always_allow_available: bool = False) -> dict:
    meta = req.hitl_metadata or {}
    execution = meta.get("execution") or {}
    ids = {i for i in (req.agent_id, req.responded_by) if i is not None}
    names = await lookup_members_by_ids(ids, session) if ids else {}
    title, prompt = svc.card_texts(req, locale)
    return {
        "id": str(req.id),
        "state": _state(req),
        "action_key": meta.get("action_key"),
        "target": _target_of(meta.get("snapshot"), meta.get("action_key")),
        "reversible": (svc.SPECS[meta["action_key"]].reversible if meta.get("action_key") in svc.SPECS else "no"),
        "title": title,  # in the READER's language (the web proxy sends the screen's locale as Accept-Language), not the language of the agent's request
        "prompt": prompt,
        "project_id": str(req.project_id),
        "requested_by": {"id": str(req.agent_id), "name": (names.get(req.agent_id).name if names.get(req.agent_id) else None)},
        "decided_by": ({"id": str(req.responded_by), "name": (names.get(req.responded_by).name if names.get(req.responded_by) else None)} if req.responded_by else None),
        "decided_at": req.responded_at.isoformat() if req.responded_at else None,
        "created_at": req.created_at.isoformat() if req.created_at else None,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "execution": {k: execution.get(k) for k in ("state", "http_status", "reason")} if execution else None,
        # the card's second button (story 5041 ② step 3): only for an organisation owner / admin looking at an ask whose action can be allowed for good
        "always_allow_available": always_allow_available and _state(req) == "pending",
        # story 5041 B6 — a «화면 열기» card: no stored call, nothing to approve — a button to the screen (the key is a closed list; the href is the web route)
        "screen": ({"key": meta["screen"]["key"], "href": svc.SCREENS[meta["screen"]["key"]]} if (meta.get("screen") or {}).get("key") in svc.SCREENS else None),
    }


@router.get("/{request_id}")
async def get_agent_action(
    request: Request,
    request_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    meta = auth.claims.get("app_metadata") or {}
    if meta.get("api_key_id") and not meta.get("human_api_key_id"):
        # an agent's key: only the answer to its OWN ask, so it can see how it ended (the card is the person's; the decision is never an agent's)
        try:
            agent = await resolve_member(auth, org_id, session)
        except HTTPException:
            agent = None  # a key that is no agent's (a person's key): not an agent reading its own ask, and no session either
        if agent is None or agent.type != "agent":
            raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_PERSON_SESSION_REQUIRED", "message": "AGENT_ACTION_PERSON_SESSION_REQUIRED"})
        return await _view(session, await _load(session, auth, org_id, request_id, agent_member_id=agent.id), _locale_of(request))
    await _person(auth, org_id, session)
    req = await _load(session, auth, org_id, request_id)
    return await _view(session, req, _locale_of(request), always_allow_available=await _always_allow_available(session, req, org_id, uuid.UUID(auth.user_id)))


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
    if body.always_allow:
        # «always allow» rides on an APPROVAL by an organisation owner / admin, for an action that has an auto slot — refused BEFORE anything is claimed, so a refusal burns nothing
        if body.decision != "approve":
            raise HTTPException(status_code=422, detail={"code": "AGENT_ACTION_ALWAYS_ALLOW_NEEDS_APPROVE", "message": "AGENT_ACTION_ALWAYS_ALLOW_NEEDS_APPROVE"})
        if not await _always_allow_available(session, req, org_id, uuid.UUID(auth.user_id)):
            from app.services.project_auth import is_org_owner_or_admin

            admin = await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id)
            raise HTTPException(status_code=409 if admin else 403, detail={"code": "AGENT_ACTION_ALWAYS_ALLOW_NOT_AVAILABLE" if admin else "AGENT_ACTION_ALWAYS_ALLOW_ADMIN_REQUIRED", "message": "AGENT_ACTION_ALWAYS_ALLOW_NOT_AVAILABLE" if admin else "AGENT_ACTION_ALWAYS_ALLOW_ADMIN_REQUIRED"})

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
            await svc.notify_agent(session, req=req, presser=presser, kind="expired", locale=_locale_of(request))
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
        await svc.notify_agent(session, req=req, presser=presser, kind="rejected", locale=_locale_of(request))
        await session.commit()
        return await _view(session, await _load(session, auth, org_id, rid), _locale_of(request))

    # approve ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    if (req.hitl_metadata or {}).get("screen"):
        # a «화면 열기» card has nothing stored to run: only dismissing it (a rejection) is a decision
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_OPEN_SCREEN_NOT_APPROVABLE", "message": "AGENT_ACTION_OPEN_SCREEN_NOT_APPROVABLE"})
    was_retry = _state(req) == "retry"  # pressed before and it never finished
    if not svc.snapshot_is_sound(action_key, snap):
        logger.error("agent_action snapshot unsound request=%s action=%s", rid, action_key)
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_SNAPSHOT_INVALID", "message": "AGENT_ACTION_SNAPSHOT_INVALID"})
    if not await svc._claim(session, request_id=rid, org_id=org_id, presser_id=presser.id):
        raise HTTPException(status_code=409, detail={"code": "AGENT_ACTION_ALREADY_DECIDED", "message": "AGENT_ACTION_ALREADY_DECIDED"})
    if body.always_allow:
        # the standing permission is saved in the SAME commit as the claim: a press that lost the claim saved nothing, and the press that won saved it whatever this one call then answers
        from app.services import agent_action_policy as policy
        from app.services.activity_log import ActivityLogService

        before, _ = await policy.resolve_action_level(session, org_id=org_id, project_id=req.project_id, agent_id=req.agent_id, action_key=action_key)
        await policy.set_action_level(session, org_id=org_id, action_key=action_key, level="auto", project_id=req.project_id, agent_id=req.agent_id, set_by=presser.id)
        await ActivityLogService(session).record(
            org_id=org_id, action="agent_action_policy.set", actor_type="human", actor_id=presser.id, project_id=req.project_id,
            entity_type="agent_action_policy", entity_id=req.agent_id,
            context={"action_key": action_key, "level_before": before, "level_after": "auto", "project_id": str(req.project_id), "agent_id": str(req.agent_id), "via": "card"},
        )
    await session.commit()  # the claim is visible to everyone before the call starts — a second press loses here, not after

    try:
        resp = await svc.execute_as_presser(request, snap, request_id=rid)
    except Exception as exc:  # noqa: BLE001 — the call itself blew up: close the request as failed (nothing is retried)
        logger.error("agent_action execution raised request=%s", rid, exc_info=True)
        await svc._finish(session, request_id=rid, execution={"state": "failed", "reason": type(exc).__name__, "at": datetime.now(timezone.utc).isoformat()})
        await session.commit()
        req = await _load(session, auth, org_id, rid)
        await svc.notify_agent(session, req=req, presser=presser, kind="failed", reason=type(exc).__name__, locale=_locale_of(request))
        await session.commit()
        return await _view(session, req, _locale_of(request))

    if resp.status_code == 403:
        # this person may not do it: it goes back, untouched, for the next one — and says why in one line
        await svc._unclaim(session, request_id=rid)
        await session.commit()
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_FORBIDDEN_FOR_APPROVER", "message": "this person may not do it", "reason": svc._reason_of(resp)})

    now = datetime.now(timezone.utc).isoformat()
    # a delete that finds the thing already gone, on a request that was pressed before and did not finish: the first press did it — that is the result asked for
    already_done = was_retry and action_key.endswith(".delete") and resp.status_code == 404
    if 200 <= resp.status_code < 300 or already_done:
        await svc._finish(session, request_id=rid, execution={"state": "executed", "http_status": resp.status_code, "at": now})
        kind, reason = "approved", ""
    else:
        reason = svc._reason_of(resp)
        await svc._finish(session, request_id=rid, execution={"state": "failed", "http_status": resp.status_code, "reason": reason, "at": now})
        kind = "changed" if resp.status_code in (404, 409, 410, 422) else "failed"
    await session.commit()
    req = await _load(session, auth, org_id, rid)
    await svc.notify_agent(session, req=req, presser=presser, kind=kind, reason=reason, locale=_locale_of(request))
    await session.commit()
    return await _view(session, req, _locale_of(request))
