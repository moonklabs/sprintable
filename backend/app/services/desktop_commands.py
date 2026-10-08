"""story #4534 (E-DESKTOP-2 B-3) — a person stops an agent's turn or puts an instruction into it from the phone, and sees the
agent's session state in its DM header. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §11 (02d2cf71 v1.9 · v1.9.1).

Both commands are signed by the phone (the daemon checks — the server never opens the blob) and go down the one
`enqueue_command` path. Who may press (PO 16:13Z ⓒ): an org owner/admin, the agent's owner, or whoever confirmed the device —
and the phone must be paired to that device. Who may look (ⓐ): whoever can open the agent's DM (its project). The turn-end
notice goes once to the person who sent a [지금 지시], judged from reported states only (§11 ④).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.desktop_relay import DesktopCommand, DesktopSession
from app.models.desktop_setup import DesktopSetup
from app.services.desktop_relay import INSTRUCT_NOW_MAX, PROMPT_MAX, SESSION_KEY_PATTERN, DesktopRelayError, legacy_state, limit_view, system_view

logger = logging.getLogger(__name__)

TURN_END_EVENT_TYPE = "agent.turn_ended"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── who ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────


async def _agent(db: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID):
    from app.models.member import Member

    agent = (await db.execute(
        select(Member).where(Member.id == agent_id, Member.org_id == org_id, Member.type == "agent", Member.deleted_at.is_(None))
    )).scalar_one_or_none()
    if agent is None:
        raise DesktopRelayError(404, "agent_not_found", "no such agent")
    return agent


async def can_view(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID, agent_id: uuid.UUID) -> bool:
    """Whoever can open the agent's DM: access to one of the agent's projects (PO 16:13Z ⓐ)."""
    from app.models.member import AgentProjectProfile
    from app.services.project_auth import has_project_access

    projects = (await db.execute(select(AgentProjectProfile.project_id).where(AgentProjectProfile.member_id == agent_id))).scalars().all()
    for project_id in projects:
        if await has_project_access(db, user_id, project_id, org_id):
            return True
    return False


async def org_role(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
    """The person's role in the organization itself (org_members) — never a project role. For a person's session resolve_member
    already gives the org role (legacy om.role · anchor members.org_role); this rule reads org_members directly so it does not lean
    on the resolver's mode: a plain org member who is a project admin does not command, an org admin who is a project member does."""
    from app.models.project import OrgMember

    return (await db.execute(
        select(OrgMember.role).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id, OrgMember.deleted_at.is_(None))
    )).scalar_one_or_none()


def can_command(*, member_id: uuid.UUID, member_role: str | None, user_id: uuid.UUID, agent, setup: DesktopSetup | None) -> bool:
    """PO 16:13Z ⓒ — an org owner/admin, the agent's owner, or whoever confirmed the device (the phone's pairing is checked on
    the command itself). One function for the header's `can_command` and the command endpoint, so the two never differ."""
    if member_role in ("owner", "admin"):
        return True
    if agent.owner_member_id is not None and agent.owner_member_id == member_id:
        return True
    return setup is not None and setup.confirmed_by is not None and setup.confirmed_by == user_id


async def _agent_setups(db: AsyncSession, org_id: uuid.UUID, agent_id: uuid.UUID) -> list[DesktopSetup]:
    rows = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.org_id == org_id, DesktopSetup.revoked_at.is_(None), DesktopSetup.exchanged_at.is_not(None))
    )).scalars().all()
    return [s for s in rows if any(m.get("member_id") == str(agent_id) and m.get("kind") == "agent" for m in (s.members or []))]


# ── ① the DM header ──────────────────────────────────────────────────────────────────────────────────────────────────────


async def _conversation_named(db: AsyncSession, conversation_id: uuid.UUID, *, member_id: uuid.UUID, agent) -> dict | None:
    """story #4534 (phone contract 48616ee0 v0.3 · Kadir): the conversation an instruction would answer in — only when the person
    and the agent are both in it (the same rule as create_command's conversation_not_found) · its name as the DM header shows it
    (a title, else the agent's name for a DM). The phone's shell shows it before it signs; it is never part of what is signed."""
    from app.models.conversation import Conversation

    if not (await _participant(db, conversation_id, member_id) and await _participant(db, conversation_id, agent.id)):
        return None
    conv = (await db.execute(select(Conversation).where(Conversation.id == conversation_id))).scalar_one_or_none()
    if conv is None:
        return None
    name = conv.title or (agent.name if conv.type == "dm" else None)
    return {"id": str(conv.id), "name": name}


async def session_view(db: AsyncSession, *, member_id: uuid.UUID, member_role: str | None, user_id: uuid.UUID, org_id: uuid.UUID,
                       agent_id: uuid.UUID, conversation_id: uuid.UUID | None = None) -> dict:
    from app.models.agent_permission import AgentPermissionRequest
    from app.services import remote_control
    from app.services.agent_permissions import _reachable

    if not await can_view(db, user_id=user_id, org_id=org_id, agent_id=agent_id):
        raise DesktopRelayError(404, "agent_not_found", "no such agent")
    agent = await _agent(db, org_id, agent_id)
    setups = await _agent_setups(db, org_id, agent_id)
    # story #4534 (phone contract 48616ee0 v0.3): the names the phone's sheet and system prompt show — never signed
    view = {"agent_name": agent.name,
            "conversation": await _conversation_named(db, conversation_id, member_id=member_id, agent=agent) if conversation_id else None,
            "setup_id": None, "device_name": None, "session_key": None, "runtime": None, "state": None, "activity": None, "state_at": None, "limit": None, "instruct_now": None,
            "remote_control": await remote_control.is_enabled(db, org_id),
            "can_command": can_command(member_id=member_id, member_role=member_role, user_id=user_id, agent=agent,
                                       setup=setups[0] if setups else None),
            "pending_permission_request_id": None}
    if not setups:
        return view
    sessions = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id.in_([s.id for s in setups]), DesktopSession.agent_member_id == agent_id)
    )).scalars().all()
    if not sessions:
        return view
    # not stopped first, then the latest
    pick = sorted(sessions, key=lambda r: (r.state != "stopped", r.state_at), reverse=True)[0]
    setup = next(s for s in setups if s.id == pick.setup_id)
    now = _now()
    reachable = pick.setup_id in await _reachable(db, {pick.setup_id}, now)
    state = pick.state if pick.state == "stopped" or reachable else "unknown"
    view.update({
        "setup_id": str(setup.id), "device_name": setup.device_name, "session_key": pick.session_key, "runtime": pick.runtime,
        # story #4534 (Kadir 4960 · PO 05:36Z): `state` stays one of the five (an older web never meets a word it does not know) ·
        # `activity` = the board's own word (eight) for the new web
        "state": legacy_state(state), "activity": state, "state_at": pick.state_at.isoformat(),
        # story #4534 (contract v1.12): a usage limit's why — only while the row is a limit word and the device is heard
        "limit": limit_view(pick) if state == pick.state else None,
        # story #4599: a held turn's why (the window's folder) — only while the device is heard
        "system": system_view(pick) if state == pick.state else None,
        # story #4534 (PO 06:30Z · Kadir 06:31Z): whether [지금 지시] can go into its turn — only while the device is heard
        "instruct_now": pick.instruct_now if state == pick.state else None,
        "can_command": can_command(member_id=member_id, member_role=member_role, user_id=user_id, agent=agent, setup=setup),
    })
    if state == "waiting_permission":  # the inbox link — only a request sent to this person
        view["pending_permission_request_id"] = (await db.execute(
            select(AgentPermissionRequest.id).where(
                AgentPermissionRequest.setup_id == setup.id, AgentPermissionRequest.session_key == pick.session_key,
                AgentPermissionRequest.recipient_member_id == member_id, AgentPermissionRequest.state == "pending",
                AgentPermissionRequest.expires_at > now,
            ).order_by(AgentPermissionRequest.created_at.desc()).limit(1)
        )).scalar_one_or_none()
        if view["pending_permission_request_id"] is not None:
            view["pending_permission_request_id"] = str(view["pending_permission_request_id"])
        # story #4590 (Yuna §2): the question it waits on can only be answered in that computer's terminal — the DM strip says so in
        # place of the inbox line (whoever it was sent to: a fact of the question, not of the reader). Read from the request rows —
        # no field on the session row (Mirko's contract §5)
        view["ask_terminal_only"] = (await db.execute(
            select(AgentPermissionRequest.id).where(
                AgentPermissionRequest.setup_id == setup.id, AgentPermissionRequest.session_key == pick.session_key,
                AgentPermissionRequest.state == "pending", AgentPermissionRequest.expires_at > now,
                AgentPermissionRequest.terminal_only.is_(True),
            ).limit(1)
        )).scalar_one_or_none() is not None
    return view


# ── ② a command ──────────────────────────────────────────────────────────────────────────────────────────────────────────


class CommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # story #4599 (contract v1.13.2 · PO 14:08Z): `end_session` — the whole session ended, from the phone's [세션 끝내기] (the one handle
    # on a turn a macOS window holds); the shell signs that kind, so what was signed is what happens
    kind: Literal["stop_session", "send_prompt", "end_session"]
    session_key: str = Field(pattern=SESSION_KEY_PATTERN)
    text: str | None = Field(default=None, min_length=1, max_length=PROMPT_MAX)
    conversation_id: uuid.UUID | None = None
    idempotency_key: str = Field(min_length=1, max_length=100)
    signed: str = Field(min_length=1, max_length=16384)
    phone_key_id: uuid.UUID


async def _participant(db: AsyncSession, conversation_id: uuid.UUID, member_id: uuid.UUID) -> bool:
    from app.models.conversation import ConversationParticipant

    return (await db.execute(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id, ConversationParticipant.member_id == member_id,
        )
    )).first() is not None


async def create_command(db: AsyncSession, *, member_id: uuid.UUID, member_role: str | None, user_id: uuid.UUID,
                         org_id: uuid.UUID, agent_id: uuid.UUID, body: CommandRequest) -> tuple[DesktopCommand | None, str]:
    """→ (the command, "queued"), or (None, "already_stopped") for a stop on a session that is not working (an end on one that has
    stopped). A stop on a turn a macOS window holds is refused with its own closed reason (409 `system_wait_end_only`) — never an
    «already stopped», never an end of the session behind the person's back (story #4599 · PO 12:40Z ④ · 14:18Z)."""
    from app.services import remote_control
    from app.services.agent_permissions import _reachable, paired_phone
    from app.services.desktop_relay import enqueue_command

    if body.kind == "send_prompt" and (body.text is None or body.conversation_id is None):
        raise DesktopRelayError(422, "invalid_payload", "an instruction needs its text and conversation")
    if body.kind == "send_prompt" and len(body.text) > INSTRUCT_NOW_MAX:  # code points (Kadir 06:21Z ④) — the sheet stops it first
        raise DesktopRelayError(422, "instruct_too_long", f"an instruction into the turn is {INSTRUCT_NOW_MAX} characters at most")
    if body.kind in ("stop_session", "end_session") and (body.text is not None or body.conversation_id is not None):
        raise DesktopRelayError(422, "invalid_payload", "a stop or an end carries no text or conversation")
    agent = await _agent(db, org_id, agent_id)
    setups = {s.id: s for s in await _agent_setups(db, org_id, agent_id)}
    session = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id.in_(list(setups) or [uuid.uuid4()]),
                                     DesktopSession.session_key == body.session_key)
    )).scalars().first()
    setup = setups.get(session.setup_id) if session is not None else None
    if not can_command(member_id=member_id, member_role=member_role, user_id=user_id, agent=agent, setup=setup):
        raise DesktopRelayError(403, "not_allowed_to_command", "you cannot command this agent")
    if session is None or session.agent_member_id != agent_id:  # another agent's session, or none on its devices
        raise DesktopRelayError(404, "session_not_found", "no such session of this agent")
    # Kadir 4955 1st line: the same press again (the same key — the phone app's [결과 확인] after an end it could not see) gets back
    # the command it made, whatever the session, the computer or the switch say now — a second command, or the instruction resent
    # as a message, would put it in twice. Asked after who may command and whose session it is, so a key never reads another's.
    existing = (await db.execute(
        select(DesktopCommand).where(DesktopCommand.setup_id == setup.id,
                                     DesktopCommand.idempotency_key == f"b3:{member_id}:{body.idempotency_key}")
    )).scalar_one_or_none()
    if existing is not None:
        return existing, existing.state
    if body.kind == "send_prompt" and not (
        await _participant(db, body.conversation_id, member_id) and await _participant(db, body.conversation_id, agent_id)
    ):
        raise DesktopRelayError(404, "conversation_not_found", "no such conversation with this agent")
    if not await remote_control.is_enabled(db, org_id):
        raise DesktopRelayError(409, remote_control.OFF_CODE, "remote control is off for this organization")
    if setup.id not in await _reachable(db, {setup.id}, _now()):
        raise DesktopRelayError(409, "device_unreachable", "that computer has not been heard from")
    if await paired_phone(db, member_id=member_id, phone_id=body.phone_key_id, setup_id=setup.id) is None:
        raise DesktopRelayError(409, "phone_not_paired", "this phone is not paired with that computer")
    # story #4599 (PO 12:40Z ④ · 14:18Z): a stop while a macOS window holds the turn is refused with its own closed reason — the
    # session is not stopped, it is frozen in that window (an Esc cannot reach it), and a stop is never turned into an end of the
    # session behind the person's back. Asked BEFORE the «not working» line below: that line would answer «already_stopped», a false
    # answer to the phone · the web · an MCP caller. The phone shows no [멈춤] there (only [세션 끝내기] → end_session); this is the race
    # of a press just before the window came up. The daemon refuses with the same word (Mirko 385).
    if body.kind == "stop_session" and session.state == "waiting_system":
        raise DesktopRelayError(409, SYSTEM_WAIT_END_ONLY, "a macOS window holds this turn — only an end of the session goes through")
    # a stop while it works or while it waits on a person's permission (Kadir 325 · PO 04:34Z — the daemon stops it then too); an
    # instruction only into a running turn; an end of the session whenever it has not stopped (PO 14:08Z: always ends)
    if body.kind == "stop_session" and session.state not in ("working", "waiting_permission"):
        return None, "already_stopped"
    if body.kind == "end_session" and session.state == "stopped":
        return None, "already_stopped"
    if body.kind == "send_prompt" and session.state != "working":
        raise DesktopRelayError(409, "session_not_working", "the turn has ended — send it as a message")
    payload: dict = {"session_key": body.session_key, "signed": body.signed}
    if body.kind == "send_prompt":
        payload.update(text=body.text, conversation_id=str(body.conversation_id))
    cmd = await enqueue_command(
        db, setup=setup, kind=body.kind, payload=payload, idempotency_key=f"b3:{member_id}:{body.idempotency_key}",
        requested_by=member_id,
    )
    # the conversation's «지시 · 지금 턴에 보냄» line is written when the daemon says the instruction went in (on_command_done), not
    # here — written at the press, it stood in the DM for an instruction the turn then refused (a tool open past the daemon's wait),
    # next to the phone's message sent instead: one instruction read as two (phone run 4 · PO 03:30Z ②)
    return cmd, cmd.state


async def _line_written(db: AsyncSession, command_id: uuid.UUID) -> bool:
    from app.models.conversation import ConversationMessage

    return (await db.execute(
        select(ConversationMessage.id).where(ConversationMessage.msg_metadata["remote_prompt"]["command_id"].astext == str(command_id))
    )).first() is not None


async def _write_prompt_line(db: AsyncSession, *, org_id, conversation_id, sender_id, agent_id, text: str, command_id,
                             after_step: bool = False) -> None:
    """«지시 · 지금 턴에 보냄» + the text, from the person who sent it (명세 B-3). Not dispatched to the agent — it already has
    the instruction in its turn; a second copy as a message would be a second instruction."""
    from app.models.conversation import ConversationMessage
    from app.services.i18n_catalog import t
    from app.services.org_locale import resolve_org_locale

    locale = await resolve_org_locale(db, org_id)
    db.add(ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id,
        content=f"{t('desktop_command.prompt_line_after_step' if after_step else 'desktop_command.prompt_line', locale)}\n{text}",
        mentioned_ids=[],
        msg_metadata={"activation": {"audience": [], "kind": "remote_prompt", "expects_response": False},
                      "remote_prompt": {"command_id": str(command_id), "agent_member_id": str(agent_id)}},
    ))
    await db.flush()


async def get_command(db: AsyncSession, *, member_id: uuid.UUID, org_id: uuid.UUID, agent_id: uuid.UUID, command_id: uuid.UUID) -> dict:
    row = (await db.execute(
        select(DesktopCommand, DesktopSetup).join(DesktopSetup, DesktopSetup.id == DesktopCommand.setup_id).where(
            DesktopCommand.id == command_id, DesktopCommand.requested_by == member_id, DesktopSetup.org_id == org_id,
            DesktopCommand.kind.in_(("stop_session", "send_prompt", "end_session")),
        )
    )).first()
    if row is None:
        raise DesktopRelayError(404, "command_not_found", "no such command of yours")
    cmd, setup = row
    session = (await db.execute(
        select(DesktopSession.agent_member_id).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == cmd.session_key)
    )).scalar_one_or_none()
    if session != agent_id:
        raise DesktopRelayError(404, "command_not_found", "no such command of yours")
    return {"command_id": str(cmd.id), "kind": cmd.kind, "state": cmd.state, "result_code": cmd.result_code}


# ── ④ the turn's end ─────────────────────────────────────────────────────────────────────────────────────────────────────


# story #4534: the words a turn ends in (a [지금 지시]'s sender is told once)
TURN_ENDED_STATES = ("idle", "waiting_input", "error", "paused_limit")
# story #4599 (PO 14:18Z): the closed reason a stop gets on a turn a macOS window holds — the server's and the daemon's one word
SYSTEM_WAIT_END_ONLY = "system_wait_end_only"


async def on_session_reported(db: AsyncSession, setup: DesktopSetup, session_key: str, state: str, at: datetime) -> None:
    """Called for every reported state (a single report or a snapshot's line). Reported values only — `unknown` is a reading,
    never reported (PO 16:13Z ③).
    - a resting word (`idle` · `waiting_input` · `error` · `paused_limit`) after a phone's [지금 지시] was done → the sender is told once.
    - `stopped`, or a stop of that session done → the waiting instructions close without a notice."""
    open_prompts = select(DesktopCommand).where(
        DesktopCommand.setup_id == setup.id, DesktopCommand.session_key == session_key, DesktopCommand.kind == "send_prompt",
        DesktopCommand.state == "done", DesktopCommand.turn_end_notified_at.is_(None),
    )
    if state == "stopped":
        await _close_prompts(db, setup.id, session_key)
        return
    # story #4534 (contract v1.12): the turn ended in any of the resting words — before, the daemon folded waiting_input · error ·
    # paused_limit into idle, so the sender was told then too; still told now that they arrive as themselves
    if state not in TURN_ENDED_STATES:
        return
    for cmd in (await db.execute(open_prompts.with_for_update())).scalars().all():
        if cmd.finished_at is None or at <= cmd.finished_at:
            continue  # an idle from before the instruction went in
        cmd.turn_end_notified_at = _now()
        await _notify_turn_end(db, setup, cmd)
    await db.flush()


async def _close_prompts(db: AsyncSession, setup_id: uuid.UUID, session_key: str) -> None:
    await db.execute(
        update(DesktopCommand).where(
            DesktopCommand.setup_id == setup_id, DesktopCommand.session_key == session_key, DesktopCommand.kind == "send_prompt",
            DesktopCommand.turn_end_notified_at.is_(None),
        ).values(turn_end_notified_at=_now())
    )


async def on_command_done(db: AsyncSession, cmd: DesktopCommand) -> None:
    """A stop of the session done: its waiting instructions close without a turn-end notice.
    An instruction done: its one line in the conversation — «sent into the current turn», or after_step «queued after the step in
    progress» (Yuna 03:49Z: it has not gone in yet). Refused or failed: no line — the phone sends the words as a message instead
    (sent_as_message), and that message is the record."""
    if cmd.kind in ("stop_session", "end_session") and cmd.state == "done" and cmd.session_key:
        await _close_prompts(db, cmd.setup_id, cmd.session_key)
    if cmd.kind == "send_prompt" and cmd.state == "done" and not await _line_written(db, cmd.id):
        payload = cmd.payload or {}
        setup = await db.get(DesktopSetup, cmd.setup_id)
        agent_id = (await db.execute(
            select(DesktopSession.agent_member_id).where(DesktopSession.setup_id == cmd.setup_id,
                                                         DesktopSession.session_key == cmd.session_key)
        )).scalar_one_or_none()
        if setup is not None and agent_id is not None and payload.get("conversation_id") and payload.get("text") is not None:
            await _write_prompt_line(db, org_id=setup.org_id, conversation_id=uuid.UUID(str(payload["conversation_id"])),
                                     sender_id=cmd.requested_by, agent_id=agent_id, text=payload["text"], command_id=cmd.id,
                                     after_step=cmd.result_code == "after_step")


def _turn_end_kind(row: DesktopSession | None) -> tuple[str | None, str | None]:
    """(title kind, body kind) for the state a turn ended in — (None, None) = idle's own words."""
    if row is None or row.state == "idle":
        return None, None
    if row.state == "waiting_input":
        return ("usage_limit", "usage_limit") if row.limit_self_resume else ("waiting_input", "waiting_input")
    if row.state == "paused_limit":
        return "paused_limit", "paused_limit"
    if row.state == "error":
        return "error", ("error_limit" if row.limited else "error")
    return None, None


async def _notify_turn_end(db: AsyncSession, setup: DesktopSetup, cmd: DesktopCommand) -> None:
    from app.models.member import Member
    from app.services.i18n_catalog import t
    from app.services.notification_dispatch import dispatch_notification
    from app.services.org_locale import resolve_org_locale

    row = (await db.execute(
        select(DesktopSession).where(DesktopSession.setup_id == setup.id, DesktopSession.session_key == cmd.session_key)
    )).scalar_one_or_none()
    agent_id = row.agent_member_id if row else None
    agent_name = (await db.execute(select(Member.name).where(Member.id == agent_id))).scalar_one_or_none() or "" if agent_id else ""
    locale = await resolve_org_locale(db, setup.org_id)
    # story #4534 (Yuna 04:05Z): the words of the state the turn ended in (idle keeps its own)
    title_kind, body_kind = _turn_end_kind(row)
    title_key = "desktop_command.turn_end_title" + (f".{title_kind}" if title_kind else "")
    bare_key = "desktop_command.turn_end_title_bare" + (f".{title_kind}" if title_kind else "")
    body_key = "desktop_command.turn_end_body" + (f".{body_kind}" if body_kind else "")
    title = t(title_key, locale, agent=agent_name) if agent_name else t(bare_key, locale)
    await dispatch_notification(
        db, org_id=setup.org_id, event_type="agent.turn_ended", target_member_ids=[cmd.requested_by],
        title=title, body=t(body_key, locale),
        reference_type="conversation", reference_id=cmd.conversation_id, source_project_id=setup.project_id,
        event={"payload": {"agent_name": agent_name}},
    )


# ── the header's nudge ───────────────────────────────────────────────────────────────────────────────────────────────────


async def session_watchers(db: AsyncSession, agent_ids: set[uuid.UUID]) -> dict[uuid.UUID, set[uuid.UUID]]:
    """agent → the people in a DM with it (§11 ① — they re-read the header chip on `desktop.session_changed`)."""
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member

    if not agent_ids:
        return {}
    agent_side = select(ConversationParticipant.conversation_id, ConversationParticipant.member_id).join(
        Conversation, Conversation.id == ConversationParticipant.conversation_id
    ).where(Conversation.type == "dm", ConversationParticipant.member_id.in_(agent_ids)).subquery()
    rows = (await db.execute(
        select(agent_side.c.member_id, ConversationParticipant.member_id)
        .join(ConversationParticipant, ConversationParticipant.conversation_id == agent_side.c.conversation_id)
        .join(Member, Member.id == ConversationParticipant.member_id)
        .where(Member.type == "human")
    )).all()
    out: dict[uuid.UUID, set[uuid.UUID]] = {}
    for agent_id, person in rows:
        out.setdefault(agent_id, set()).add(person)
    return out


def push_session_changed(watchers: dict[uuid.UUID, set[uuid.UUID]]) -> None:
    """After the commit: a body-less nudge — the header reads the state again (nothing about the session rides on it)."""
    from app.routers.events import _push_to_agent

    for agent_id, people in watchers.items():
        for person in people:
            try:
                _push_to_agent(str(person), {"event_type": "desktop.session_changed", "agent_member_id": str(agent_id)})
            except Exception:  # noqa: BLE001 — a missed nudge waits for the header's 30-second read
                logger.warning("desktop.session_changed push failed", exc_info=True)
