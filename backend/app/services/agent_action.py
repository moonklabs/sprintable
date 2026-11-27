"""story 5041 (C0b) — an agent asks, a person presses, the SERVER runs it as that person.

Before: the server turned an agent away (403) from a handful of things that cannot be undone, and the MCP hid the tools. A person who told an agent in chat «close that sprint» got
«I cannot» — and no road.

Now: the agent calls the tool as it calls any other. For the actions in `SPECS` the server does NOT run it — it keeps a REQUEST (an `agent_hitl_requests` row, `request_type =
'agent_action'`) that holds a snapshot of the exact call, puts a card with the SERVER's own words in the approver's chat, and answers the agent at once with `202 pending_approval`.
A person presses the card (`POST /api/v2/agent-actions/{id}/decision`); the server then makes the SAME call, in this process, with THE PRESSER'S credentials — so every right
check (org owner / admin, the project, the deletion audit's actor) is the presser's, and the record says the person did it, not the agent.

What this module keeps true:
  · the snapshot is built by the server from the request it is looking at — the agent names no path; at press time the method + path must still match the action's pattern and the
    stored hash must still match the stored fields;
  · one claim only — `pending → approved` is one atomic UPDATE; whoever loses it gets 409 and nothing runs twice;
  · a person without the right does not burn the request: a 403 from the call puts it back to `pending` for the next person;
  · nobody pressing within 24 hours is a REFUSAL, never an approval;
  · the same action with the same arguments asked again while one is open is the SAME request (no pile of cards); an agent has an hourly ceiling.
"""
from __future__ import annotations

import asyncio
import base64
import contextvars
import hashlib
import json
import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import ConversationMessage
from app.models.hitl import HitlRequest
from app.services.i18n_catalog import t

logger = logging.getLogger(__name__)

REQUEST_TYPE = "agent_action"
EXPIRES_AFTER = timedelta(hours=24)
MAX_OPEN_PER_AGENT_PER_HOUR = 20
MAX_CARD_RECIPIENTS = 3
SNAPSHOT_BODY_LIMIT = 64 * 1024
EXECUTE_TIMEOUT = timedelta(seconds=120)  # the replay is CANCELLED after this (its transaction rolls back) — so a request «running» for longer than RUNNING_STALE_AFTER (> this) has no live replay behind it
RUNNING_STALE_AFTER = timedelta(minutes=5)  # a press whose execution has not finished by then is taken as not finished (the process may have died) — it can be pressed again; the replay is idempotent

# The id of the request whose stored call is being replayed RIGHT NOW, set only by `execute_as_presser` in this process (a context variable — no client can set it: it is not read from any header). The one
# handler that must not run twice for one request (a reward) reads it and leaves the request id in its own table, where the database refuses a second row.
_REPLAYING: contextvars.ContextVar[uuid.UUID | None] = contextvars.ContextVar("agent_action_replaying", default=None)


def replaying_request_id() -> uuid.UUID | None:
    return _REPLAYING.get()

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"


@dataclass(frozen=True)
class ActionSpec:
    key: str
    what_key: str          # the catalogue key of the one line that names what is asked
    method: str
    path_re: re.Pattern[str]
    reversible: str        # 'no' | 'partly'
    takes_body: bool = False  # only an action whose endpoint reads a body (a reward) may carry one; for the rest the stored call has NO query and NO body — nothing rides along that the card does not show


def _spec(key: str, what: str, method: str, pattern: str, reversible: str, takes_body: bool = False) -> ActionSpec:
    return ActionSpec(key=key, what_key=f"agent_action.what.{what}", method=method, path_re=re.compile(pattern), reversible=reversible, takes_body=takes_body)


# The registry — one place that says which calls an agent may ASK for (every one of them is a call a person may make on screen). The route handlers name their key; nothing else
# decides. Anything not here is not an approvable action.
SPECS: dict[str, ActionSpec] = {s.key: s for s in (
    _spec("story.delete", "story_delete", "DELETE", rf"^/api/v2/stories/{_UUID}$", "no"),
    _spec("task.delete", "task_delete", "DELETE", rf"^/api/v2/tasks/{_UUID}$", "no"),
    _spec("goal.delete", "goal_delete", "DELETE", rf"^/api/v2/(?:goals|epics)/{_UUID}$", "no"),
    _spec("doc.delete", "doc_delete", "DELETE", rf"^/api/v2/docs/{_UUID}$", "no"),
    _spec("sprint.delete", "sprint_delete", "DELETE", rf"^/api/v2/sprints/{_UUID}$", "no"),
    _spec("sprint.close", "sprint_close", "POST", rf"^/api/v2/sprints/{_UUID}/close$", "partly"),
    _spec("meeting.delete", "meeting_delete", "DELETE", rf"^/api/v2/meetings/{_UUID}$", "no"),
    _spec("reward.give", "reward_give", "POST", r"^/api/v2/rewards$", "no", takes_body=True),
    _spec("spec_pin.delete", "spec_pin_delete", "DELETE", rf"^/api/v2/visual-artifacts/{_UUID}/pins/{_UUID}$", "no"),
)}


def snapshot_hash(snap: dict[str, Any]) -> str:
    canon = json.dumps({k: snap.get(k) for k in ("method", "path", "query", "body_b64", "content_type", "org_id", "project_id")}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


async def build_snapshot(request: Request, *, org_id: uuid.UUID, project_id: uuid.UUID) -> dict[str, Any]:
    body = await request.body()
    if len(body) > SNAPSHOT_BODY_LIMIT:
        raise HTTPException(status_code=413, detail={"code": "AGENT_ACTION_BODY_TOO_LARGE", "message": "AGENT_ACTION_BODY_TOO_LARGE"})
    snap = {
        "method": request.method.upper(),
        "path": request.url.path,
        "query": request.url.query or "",
        "body_b64": base64.b64encode(body).decode() if body else "",
        "content_type": request.headers.get("content-type", "") if body else "",
        "org_id": str(org_id),
        "project_id": str(project_id),
    }
    snap["sha256"] = snapshot_hash(snap)
    return snap


def snapshot_is_sound(action_key: str, snap: dict[str, Any]) -> bool:
    """at press time: the action is registered, method + path still fit ITS pattern, and the hash still matches the stored fields (a row edited by hand does not run)"""
    spec = SPECS.get(action_key)
    if spec is None or not isinstance(snap, dict):
        return False
    return (
        snap.get("method") == spec.method
        and isinstance(snap.get("path"), str) and spec.path_re.fullmatch(snap["path"]) is not None
        and (spec.takes_body or (not snap.get("query") and not snap.get("body_b64")))
        and snap.get("sha256") == snapshot_hash(snap)
    )


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def is_expired(req: HitlRequest, now: datetime | None = None) -> bool:
    exp = _aware(req.expires_at)
    return req.status == "pending" and exp is not None and exp <= (now or datetime.now(timezone.utc))


async def _approver_ids(session: AsyncSession, *, org_id: uuid.UUID, agent_id: uuid.UUID) -> list[uuid.UUID]:
    """who gets the card: the agent's own person (the one who made it) when there is one, else the organization's owner / admins (at most `MAX_CARD_RECIPIENTS`).
    Whoever presses runs it under THEIR rights — so this only decides who is ASKED first, not who may."""
    from app.models.member import Member
    from app.models.project import OrgMember

    owner_id = (await session.execute(select(Member.owner_member_id).where(Member.id == agent_id, Member.org_id == org_id))).scalar_one_or_none()
    if owner_id is not None:
        alive = (await session.execute(select(OrgMember.id).where(OrgMember.id == owner_id, OrgMember.org_id == org_id, OrgMember.deleted_at.is_(None)))).scalar_one_or_none()
        if alive is not None:
            return [alive]
    rows = (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.role.in_(("owner", "admin")), OrgMember.deleted_at.is_(None))
        .order_by(OrgMember.role.desc(), OrgMember.created_at.asc()).limit(MAX_CARD_RECIPIENTS)
    )).scalars().all()
    return list(rows)


async def _post_card(session: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID, agent: Any, approver_id: uuid.UUID | None, req: HitlRequest, locale: str, text_line: str, room: Any = None) -> uuid.UUID | None:
    """one card message: in the ROOM the request came from (when the run says which) else in the approver's DM with the agent. The message carries `card = {kind: agent_action, ref: request id}` —
    the web draws it from the request itself (GET /api/v2/agent-actions/{id}), so the card never goes stale."""
    from app.routers.conversations import dispatch_conversation_event_live
    from app.services.approval_delivery import _get_or_create_approval_dm

    try:
        async with session.begin_nested():
            conv = room if room is not None else await _get_or_create_approval_dm(session, org_id=org_id, project_id=project_id, requester_id=agent.id, approver_id=approver_id)
            msg = ConversationMessage(
                conversation_id=conv.id,
                sender_id=agent.id,
                content=text_line,
                mentioned_ids=[approver_id] if approver_id is not None else [],
                # a literal the code builds here (the metadata ratchet: a new line never takes its metadata from another row or a variable)
                msg_metadata={
                    "agent_action": {"request_id": str(req.id), "action_key": req.hitl_metadata.get("action_key")},
                    "card": {"kind": "agent_action", "ref": str(req.id)},
                    **({"activation": {"audience": [str(approver_id)], "kind": "request", "expects_response": True}} if approver_id is not None else {}),
                },
            )
            session.add(msg)
            await session.flush()
            await dispatch_conversation_event_live(session, conv, msg, org_id, agent)
            return msg.id
    except Exception:  # noqa: BLE001 — one recipient's failure never loses the request; the reply to the agent says honestly that no card went
        logger.error("agent_action card delivery failed request=%s approver=%s", req.id, approver_id, exc_info=True)
        return None


async def _room_of_request(session: AsyncSession, request: Request, *, agent: Any, org_id: uuid.UUID, project_id: uuid.UUID) -> tuple[Any, uuid.UUID | None] | None:
    """the room a person asked the agent in, when the agent's RUN says so: `X-Sprintable-Run-Id` (the runtime puts it on every MCP call) naming a RUNNING run of THIS agent whose `conversation_id` is a live room of this
    organization (the agent is in it; it is no other project's room; every other member of it can see the project). Nothing is guessed from «the agent's only running run» — no header, a run of another agent, a room that is gone or not this project's =
    `None` and the card goes to the person's DM as before. Second value = the person whose message started the run (a person's id), to be named on the card."""
    from app.models.agent_run import AgentRun
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.services.project_auth import has_project_access

    raw = request.headers.get("x-sprintable-run-id")
    try:
        run_id = uuid.UUID(raw) if raw else None
    except ValueError:
        run_id = None
    if run_id is None:
        return None
    run = (await session.execute(
        select(AgentRun.conversation_id, AgentRun.triggering_message_id).where(AgentRun.id == run_id, AgentRun.agent_id == agent.id, AgentRun.org_id == org_id, AgentRun.status == "running")
    )).first()
    if run is None or run.conversation_id is None:
        return None
    conv = (await session.execute(select(Conversation).where(Conversation.id == run.conversation_id, Conversation.org_id == org_id))).scalar_one_or_none()
    if conv is None or getattr(conv, "deleted_at", None) is not None:
        return None
    if getattr(conv, "project_id", None) not in (None, project_id):
        return None
    inside = (await session.execute(
        select(ConversationParticipant.id).where(ConversationParticipant.conversation_id == conv.id, ConversationParticipant.member_id == agent.id)
    )).first()
    if inside is None:
        return None
    # the card's line names the ask (a story's title, a sprint's name): everyone in the room must be able to see this project — one who cannot would read it in the room though the card itself is a 404 for them
    others = (await session.execute(select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == conv.id, ConversationParticipant.member_id != agent.id))).scalars().all()
    for other in others:
        kind = (await session.execute(select(Member.type).where(Member.id == other, Member.org_id == org_id))).scalar_one_or_none()
        if kind == "human":
            # a person is judged by their login (the participant row holds the org-member anchor id)
            who = (await session.execute(select(OrgMember.user_id).where(OrgMember.id == other, OrgMember.org_id == org_id, OrgMember.deleted_at.is_(None)))).scalar_one_or_none()
        else:
            who = other if kind == "agent" else None
        if who is None or not await has_project_access(session, who, project_id, org_id):
            return None
    asker: uuid.UUID | None = None
    if run.triggering_message_id is not None:
        sender = (await session.execute(select(ConversationMessage.sender_id).where(ConversationMessage.id == run.triggering_message_id, ConversationMessage.conversation_id == conv.id))).scalar_one_or_none()
        if sender is not None:
            kind = (await session.execute(select(Member.type).where(Member.id == sender, Member.org_id == org_id))).scalar_one_or_none()
            asker = sender if kind == "human" else None
    return conv, asker


def plain_text(text_: str | None, limit: int) -> str:
    """text that came from somewhere else (an agent's reason, a title) as ONE plain line: control, line-break and invisible direction / format characters become spaces or go, whitespace collapses —
    so it cannot fake the structure of the card's own sentence"""
    cleaned = "".join(" " if (ch.isspace() or unicodedata.category(ch) in ("Cc", "Zl", "Zp")) else ("" if unicodedata.category(ch) == "Cf" else ch) for ch in (text_ or ""))
    return " ".join(cleaned.split())[:limit]


def _what(spec: ActionSpec, target_label: str, locale: str) -> str:
    return t(spec.what_key, locale, target=plain_text(target_label, 120) or "—")


async def request_approval(
    request: Request,
    session: AsyncSession,
    *,
    auth: Any,
    agent: Any,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    action_key: str,
    target_label: Any,
    locale: str | None = None,
) -> JSONResponse:
    """called by a route handler in place of `403` when the caller is an agent. The agent must be able to see the project (the same check a person's call makes), else the app's one 404 like
    before. Returns the `202` the agent is given."""
    from app.services.agent_onboarding_config import resolve_locale_from_request
    from app.services.project_auth import require_project_access

    locale = locale or resolve_locale_from_request(None, request.headers.get("accept-language"))
    spec = SPECS.get(action_key)
    if spec is None:
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_NOT_APPROVABLE", "message": "AGENT_ACTION_NOT_APPROVABLE"})
    await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id)  # the app's one judgement (404 — a project the agent cannot see is not told apart from one that is not there)

    snap = await build_snapshot(request, org_id=org_id, project_id=project_id)
    if not spec.takes_body:
        # the endpoint ignores a query / body on these — and the card shows none: drop them, so what is stored is exactly what the card names
        snap = {**snap, "query": "", "body_b64": "", "content_type": ""}
        snap["sha256"] = snapshot_hash(snap)
    if not snapshot_is_sound(action_key, snap):
        raise HTTPException(status_code=403, detail={"code": "AGENT_ACTION_NOT_APPROVABLE", "message": "AGENT_ACTION_NOT_APPROVABLE"})

    if callable(target_label):
        target_label = target_label(locale)  # a label that needs the catalogue (a count · a name) is built here, in the request's language
    now = datetime.now(timezone.utc)
    # one asker at a time: «look for the same open ask, count the hour, insert» is check-then-insert — two retries at once would both see nothing and make two cards (a person pressing both = the
    # reward given twice) and the hourly ceiling would be walked past. The lock is per agent and lives to the end of this request's transaction.
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"agent_action:{org_id}:{agent.id}"})
    # the same ask while one is open is the same request — no pile of cards (the agent may retry, loop, or be told twice)
    open_same = (await session.execute(
        select(HitlRequest).where(
            HitlRequest.org_id == org_id, HitlRequest.request_type == REQUEST_TYPE, HitlRequest.agent_id == agent.id, HitlRequest.status == "pending",
            HitlRequest.deleted_at.is_(None), HitlRequest.expires_at > now,
            HitlRequest.hitl_metadata["snapshot"]["sha256"].astext == snap["sha256"],
        ).order_by(HitlRequest.created_at.desc()).limit(1)
    )).scalar_one_or_none()
    if open_same is not None:
        return _pending_response(open_same, locale, card_delivered=bool(open_same.hitl_metadata.get("cards")))

    recent = (await session.execute(
        select(func.count()).select_from(HitlRequest).where(
            HitlRequest.org_id == org_id, HitlRequest.request_type == REQUEST_TYPE, HitlRequest.agent_id == agent.id,
            HitlRequest.created_at > now - timedelta(hours=1), HitlRequest.deleted_at.is_(None),
        )
    )).scalar_one()
    if recent >= MAX_OPEN_PER_AGENT_PER_HOUR:
        raise HTTPException(status_code=429, detail={"code": "AGENT_ACTION_RATE_LIMITED", "message": "AGENT_ACTION_RATE_LIMITED"})

    approvers = await _approver_ids(session, org_id=org_id, agent_id=agent.id)
    room = await _room_of_request(session, request, agent=agent, org_id=org_id, project_id=project_id)
    asker = room[1] if room else None
    what = _what(spec, target_label, locale)
    agent_name = agent.name or "—"
    req = HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=agent.id, request_type=REQUEST_TYPE,
        title=what[:300],
        prompt=t("agent_action.prompt.irreversible" if spec.reversible == "no" else "agent_action.prompt.partly", locale),
        requested_for=asker or (approvers[0] if approvers else agent.id),
        status="pending", expires_at=now + EXPIRES_AFTER,
        hitl_metadata={
            "action_key": action_key, "snapshot": snap, "target_label": (target_label or "")[:200],
            "requested_by_agent": {"id": str(agent.id), "name": agent.name}, "cards": [],
        },
    )
    session.add(req)
    await session.flush()

    text_line = t("agent_action.card_text", locale, what=what, agent=agent_name)
    cards: list[dict[str, str]] = []
    # story 5053 — the rooms of this card are locked in room-id order before the first message goes in (the same rule as the gate fan-out: opposite orders must queue, not deadlock)
    from app.services.approval_delivery import lock_rooms_in_id_order, prepare_card_rooms

    if room is not None:
        await lock_rooms_in_id_order(session, [room[0].id])
    else:
        await prepare_card_rooms(session, org_id=org_id, project_id=project_id, requester_id=agent.id, approver_ids=list(approvers))
    if room is not None:
        # the room the person asked in: ONE card there (whoever may do it on screen may press — it names the person who asked, nobody else is excluded)
        message_id = await _post_card(session, org_id=org_id, project_id=project_id, agent=agent, approver_id=asker, req=req, locale=locale, text_line=text_line, room=room[0])
        if message_id is not None:
            cards.append({"approver_id": str(asker) if asker else None, "message_id": str(message_id), "conversation_id": str(room[0].id)})
    if not cards:
        for approver_id in approvers:
            message_id = await _post_card(session, org_id=org_id, project_id=project_id, agent=agent, approver_id=approver_id, req=req, locale=locale, text_line=text_line)
            if message_id is not None:
                cards.append({"approver_id": str(approver_id), "message_id": str(message_id)})
    req.hitl_metadata = {**req.hitl_metadata, "cards": cards}
    await session.flush()
    if not cards:
        logger.error("agent_action request has no card delivered request=%s agent=%s", req.id, agent.id)
    return _pending_response(req, locale, card_delivered=bool(cards))


def _pending_response(req: HitlRequest, locale: str, *, card_delivered: bool) -> JSONResponse:
    hours = int(EXPIRES_AFTER.total_seconds() // 3600)
    return JSONResponse(
        status_code=202,
        content={
            "status": "pending_approval",
            "request_id": str(req.id),
            "expires_at": _aware(req.expires_at).isoformat() if req.expires_at else None,
            "card_delivered": card_delivered,
            "message": t("agent_action.reply_pending" if card_delivered else "agent_action.reply_no_card", locale, request_id=str(req.id), hours=hours),
        },
    )


# ─── the press ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async def _claim(session: AsyncSession, *, request_id: uuid.UUID, org_id: uuid.UUID, presser_id: uuid.UUID) -> bool:
    """`pending → approved` once: the only thing that lets an execution start"""
    res = await session.execute(
        text(
            "UPDATE agent_hitl_requests SET status = 'approved', responded_by = :who, responded_at = now(), "
            "metadata = jsonb_set(metadata, '{execution}', CAST(:ex AS jsonb), true) "
            "WHERE id = :id AND org_id = :org AND request_type = :rt AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND ("
            " status = 'pending' OR "
            # a claim that never finished (the process died mid-call): taken over ONCE, atomically — and the replay carries the request id as its idempotency key, so nothing is done twice
            " (status = 'approved' AND metadata->'execution'->>'state' = 'running' AND responded_at < now() - make_interval(secs => :stale)))"
        ),
        {"who": presser_id, "id": request_id, "org": org_id, "rt": REQUEST_TYPE, "ex": json.dumps({"state": "running"}), "stale": RUNNING_STALE_AFTER.total_seconds()},
    )
    return (res.rowcount or 0) == 1


async def _unclaim(session: AsyncSession, *, request_id: uuid.UUID) -> None:
    """the call said 403 (the presser has no right to do this): give the request back, untouched, for the next person"""
    await session.execute(
        text(
            "UPDATE agent_hitl_requests SET status = 'pending', responded_by = NULL, responded_at = NULL, metadata = metadata - 'execution' "
            "WHERE id = :id AND status = 'approved' AND metadata->'execution'->>'state' = 'running'"
        ),
        {"id": request_id},
    )


async def _finish(session: AsyncSession, *, request_id: uuid.UUID, execution: dict[str, Any]) -> None:
    await session.execute(
        text("UPDATE agent_hitl_requests SET metadata = jsonb_set(metadata, '{execution}', CAST(:ex AS jsonb), true) WHERE id = :id"),
        {"id": request_id, "ex": json.dumps(execution)},
    )


async def execute_as_presser(request: Request, snap: dict[str, Any], *, request_id: uuid.UUID) -> httpx.Response:
    """the SAME call, in this process, with the presser's own credentials (the `Authorization` of the pressing request — nothing is minted or stored)"""
    # ONLY `Authorization` (the one credential the backend's own auth reads for a person's session): not `Cookie`, and never `X-Agent-Api-Key` — so the replay is the identity that was just
    # checked, whatever else rode on the pressing request
    headers = {k: v for k, v in ((h, request.headers.get(h)) for h in ("authorization",)) if v}
    headers["x-org-id"] = snap["org_id"]
    headers["x-project-id"] = snap["project_id"]
    headers["x-sprintable-agent-action"] = str(request_id)
    if snap.get("content_type"):
        headers["content-type"] = snap["content_type"]
    url = snap["path"] + (("?" + snap["query"]) if snap.get("query") else "")
    body = base64.b64decode(snap["body_b64"]) if snap.get("body_b64") else None
    token = _REPLAYING.set(request_id)
    try:
        async with asyncio.timeout(EXECUTE_TIMEOUT.total_seconds()):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=request.app), base_url="http://agent-action.internal", timeout=60.0) as client:
                return await client.request(snap["method"], url, content=body, headers=headers)
    finally:
        _REPLAYING.reset(token)


async def sweep(session: AsyncSession) -> dict[str, int]:
    """the cron's one pass over this type: (a) a request nobody pressed for 24 h is declined (like a press that finds it expired) and the agent is told; (b) a press that never finished — the process
    died between the claim and the result — is given back as «did not finish» (the request id is the replay's idempotency key, so pressing again cannot do it twice) and the agent is told.
    Neither re-runs anything: the stored call needs a person's own credential, and nothing is stored."""
    expired = (await session.execute(
        text(
            "UPDATE agent_hitl_requests SET status = 'rejected', response_text = 'expired', responded_at = now() "
            "WHERE request_type = :rt AND status = 'pending' AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id"
        ),
        {"rt": REQUEST_TYPE},
    )).scalars().all()
    stuck = (await session.execute(
        text(
            "UPDATE agent_hitl_requests SET status = 'pending', responded_by = NULL, responded_at = NULL, "
            "metadata = jsonb_set(metadata, '{execution}', CAST(:ex AS jsonb), true) "
            "WHERE request_type = :rt AND status = 'approved' AND deleted_at IS NULL AND metadata->'execution'->>'state' = 'running' "
            "AND responded_at < now() - make_interval(secs => :stale) RETURNING id"
        ),
        {"rt": REQUEST_TYPE, "stale": RUNNING_STALE_AFTER.total_seconds(), "ex": json.dumps({"state": "failed", "reason": "unfinished", "retry": True})},
    )).scalars().all()
    for rid in (*expired, *stuck):
        req = (await session.execute(select(HitlRequest).where(HitlRequest.id == rid).execution_options(populate_existing=True))).scalar_one_or_none()
        if req is None:
            continue
        from app.models.member import Member

        # the line to the agent is said by the person the card was for (the same DM a press would answer in); an ask that had nobody to go to has nobody to say it — the agent sees it on its next read
        speaker = (await session.execute(select(Member).where(Member.id == req.requested_for, Member.type == "human"))).scalar_one_or_none() if req.requested_for != req.agent_id else None
        if speaker is not None:
            await notify_agent(session, req=req, presser=speaker, kind="expired" if rid in expired else "unfinished")
    return {"expired": len(expired), "unfinished": len(stuck)}


def _reason_of(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        return f"HTTP {resp.status_code}"
    detail = data.get("detail") if isinstance(data, dict) else None
    if isinstance(detail, dict):
        detail = detail.get("code") or detail.get("message")
    return (str(detail) if detail else f"HTTP {resp.status_code}")[:200]


async def notify_agent(session: AsyncSession, *, req: HitlRequest, presser: Any, kind: str, reason: str = "", locale: str = "ko") -> None:
    """tell the asking agent how it ended — a message in their DM (the way gate decisions reach an agent), best-effort"""
    from app.routers.conversations import dispatch_conversation_event_live
    from app.routers.events import _get_or_create_system_publisher
    from app.services.approval_delivery import _get_or_create_approval_dm

    spec = SPECS.get(req.hitl_metadata.get("action_key", ""))
    if spec is None:
        return
    what = _what(spec, req.hitl_metadata.get("target_label", ""), locale)
    content = t(f"agent_action.result.{kind}", locale, what=what, reason=reason) if kind in ("failed", "changed") else t(f"agent_action.result.{kind}", locale, what=what)
    try:
        async with session.begin_nested():
            conv = await _get_or_create_approval_dm(session, org_id=req.org_id, project_id=req.project_id, requester_id=req.agent_id, approver_id=presser.id)
            # the line is the SERVER's, not the person's: spoken by «시스템 발행» (the org's one server sender), so the person who pressed does not see it as their own bubble — the card says who pressed
            system = await _get_or_create_system_publisher(session, req.org_id)
            msg = ConversationMessage(
                conversation_id=conv.id, sender_id=system.id, content=content, mentioned_ids=[req.agent_id],
                msg_metadata={
                    "activation": {"audience": [str(req.agent_id)], "kind": "result", "expects_response": False},
                    "agent_action_result": {"request_id": str(req.id), "result": kind},
                },
            )
            session.add(msg)
            await session.flush()
            await dispatch_conversation_event_live(session, conv, msg, req.org_id, system)
    except Exception:  # noqa: BLE001 — a failed reply never undoes the decision
        logger.warning("agent_action result reply failed request=%s", req.id, exc_info=True)
