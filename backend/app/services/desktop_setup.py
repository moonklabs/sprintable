"""story #4424 — desktop setup in one go: the desktop app asks for a setup code, a person confirms the recipe on the web,
the app exchanges the code once for its agents' keys. No key is copied or pasted by a person.

Contract (PO 07:15Z · 07:21Z · PO decision on when keys are made — the plaintext is born in the exchange answer only):
- create (no login): `{challenge, device_name}` → a one-time code (256-bit, only its sha256 stored), 10 minutes.
- confirm (a person, org owner/admin — never an agent key): one transaction — the recipe's agent-target stages are grouped
  by their **role** (`stage_metadata[stage].role`; a stage without one is its own role — PO 08:31Z). A role declared `human`
  in `role_actor_kinds` (a table keyed by role) goes to the confirming person; every other role gets **one new** agent
  (role member · no key yet), and all of that role's stages are bound to it (the same upsert as the recipe apply API).
  Channel/connector stages are left for later («connect later»).
- exchange (no login, PKCE S256 verifier): before the confirmation `pending`; after it, once — one transaction issues one key
  per new agent (scope = the non-admin tool groups · no expiry · tied to this setup) and marks the setup handed over. Never
  again after that. Existing agents are never given a new key (issue = replace would cut their running sessions).
- revoke («disconnect this device», a person): every key this setup handed out is revoked; nothing else changes.

Failures are closed codes (`DesktopSetupError.code`); the router maps them to statuses."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.api_key import ApiKey
from app.models.desktop_setup import DesktopSetup
from app.services.oauth_handoff import pkce_challenge_from_verifier

SETUP_CODE_TTL = timedelta(minutes=10)
# story #4426 ② — the setup's own steps, written by the backend (grouped by `session_id` = the setup id). A person's action
# carries `meta.human_hand = true`; the one-line read counts those.
EVENT_CODE_ISSUED = "desktop_setup_code_issued"
EVENT_CONFIRMED = "desktop_setup_confirmed"
EVENT_EXCHANGED = "desktop_setup_exchanged"
EVENT_FIRST_RESULT = "desktop_first_result_seen"  # written by the story comment · status · stage publish paths (below)
EVENT_TOOLS_CONNECTED = "desktop_tools_connected"  # written by the MCP manifest route (below)
# sent by the desktop app — read here, carried into the catalog by the PR that sends them (this exact spelling)
EVENT_FIRST_TASK_HANDED = "desktop_first_task_handed"
EVENT_WORKDIR_FALLBACK = "desktop_workdir_fallback"
EVENT_BLOCKED = "desktop_setup_blocked"
EVENT_DOC_OPENED = "desktop_doc_opened"
# the desktop app's runtime ids → members.runtime_type (the values the rest of the product uses)
RUNTIME_TYPES = {"claude": "claude-code", "codex": "codex"}
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # base64url(sha256) without padding
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")  # RFC 7636 §4.1


class DesktopSetupError(Exception):
    """A closed code: request_invalid · service_unavailable · code_not_found · code_expired · code_used · code_not_confirmed_yet · verifier_mismatch ·
    already_confirmed · not_org_admin · recipe_not_found · roles_invalid · human_stage_needs_member · setup_not_found."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_setup_code(db: AsyncSession, *, challenge: str, device_name: str) -> tuple[str, datetime, uuid.UUID]:
    if not _CHALLENGE_RE.match(challenge):
        raise DesktopSetupError("request_invalid", "challenge must be base64url(sha256(verifier)) without padding")
    name = device_name.strip()[:80]
    if not name:
        raise DesktopSetupError("request_invalid", "device_name is required")
    from app.services.onboarding_funnel import emit_onboarding_event

    code = secrets.token_urlsafe(32)
    expires_at = _now() + SETUP_CODE_TTL
    setup = DesktopSetup(code_hash=_hash(code), code_challenge=challenge, device_name=name, expires_at=expires_at)
    db.add(setup)
    await db.flush()
    await emit_onboarding_event(db, EVENT_CODE_ISSUED, session_id=setup.id, meta={"flow": "desktop_setup"})
    # the setup id is not a secret (nothing can be done with it without an admin session); the app passes it to the web page
    # so steps before the confirmation (a sign-in) can be keyed by it (PO 08:31Z)
    return code, expires_at, setup.id


async def _setup_by_code(db: AsyncSession, code: str) -> DesktopSetup:
    row = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.code_hash == _hash(code)).with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopSetupError("code_not_found")
    return row


@dataclass
class RoleChoice:
    role: str
    runtime: str


def stage_role(definition, stage: str) -> str:
    """A stage's role (`stage_metadata[stage].role`); an older definition without one: the stage is its own role."""
    role = (definition.stage_metadata.get(stage) or {}).get("role")
    return role if isinstance(role, str) and role else stage


def ordered_agent_stages(definition) -> list[str]:
    """The agent-target stages in the recipe's own order (the payload's stage enum; else the stage_metadata order)."""
    from app.services.recipe_role_bindings import stage_target

    order = ((definition.payload_schema or {}).get("properties") or {}).get("stage", {}).get("enum") or []
    stages = [s for s in order if s in definition.stage_metadata] + [s for s in definition.stage_metadata if s not in order]
    return [s for s in stages if stage_target(definition, s) == "agent"]


async def confirm_setup(
    db: AsyncSession,
    *,
    code: str,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    recipe_id: uuid.UUID,
    roles: list[RoleChoice],
    auth,
    workdir_hint: str | None = None,
    background_tasks=None,
) -> tuple[uuid.UUID, list[dict], uuid.UUID]:
    """Returns (setup_id, members, work_item_id). Writes only through `db` and never commits — the caller commits, or rolls back on any
    error so nothing of a half-made setup stays."""
    from app.models.event_definition import EventDefinition
    from app.repositories.team_member import TeamMemberRepository
    from app.services.member_resolver import resolve_member
    from app.services.org_agent import create_org_level_agent
    from app.services.project_auth import is_org_owner_or_admin, require_project_access
    from app.services.recipe_role_bindings import upsert_role_binding

    setup = await _setup_by_code(db, code)
    if setup.revoked_at is not None or setup.exchanged_at is not None:
        raise DesktopSetupError("code_used")
    if _now() >= setup.expires_at:
        raise DesktopSetupError("code_expired")
    if setup.confirmed_at is not None:
        raise DesktopSetupError("already_confirmed")

    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    await require_project_access(db, user_id, project_id, org_id, not_found_detail="Project not found")

    definition = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.id == recipe_id,
            (EventDefinition.org_id == org_id) | (EventDefinition.org_id.is_(None)),
        )
    )).scalar_one_or_none()
    if definition is None:
        raise DesktopSetupError("recipe_not_found")

    agent_stages = ordered_agent_stages(definition)
    role_order: list[str] = []
    for s in agent_stages:
        if stage_role(definition, s) not in role_order:
            role_order.append(stage_role(definition, s))
    kinds = definition.role_actor_kinds or {}  # keyed by role (events.py reads it the same way)
    human_roles = {r for r in role_order if kinds.get(r) == "human"}
    choices: dict[str, str] = {}
    for r in roles:
        if r.role in choices or r.role not in role_order or r.role in human_roles or r.runtime not in RUNTIME_TYPES:
            raise DesktopSetupError("roles_invalid", f"role {r.role!r} / runtime {r.runtime!r}")
        choices[r.role] = r.runtime
    missing = [r for r in role_order if r not in human_roles and r not in choices]
    if missing:
        raise DesktopSetupError("roles_invalid", f"a runtime is needed for: {missing}")

    person_member_id: uuid.UUID | None = None
    if human_roles:
        try:
            person_member_id = uuid.UUID(str((await resolve_member(auth, org_id, db, project_id)).id))
        except Exception as exc:  # noqa: BLE001 — no member row in this project for the person: say so, don't guess
            raise DesktopSetupError("human_stage_needs_member") from exc

    # one member per role: the person for a human role, one new agent for every other role
    role_member: dict[str, uuid.UUID] = {}
    for role in role_order:  # the recipe's own order
        if role in human_roles:
            role_member[role] = person_member_id
            continue
        if settings.is_ee_enabled:
            from ee.plan_limits import check_agent_add_limit  # type: ignore[import]

            await check_agent_add_limit(db, org_id)  # an HTTPException(402) here rolls the whole setup back
        agent, _no_key = await create_org_level_agent(
            db, org_id=org_id, created_by=user_id, name=f"{role} · {setup.device_name}"[:120], role="member",
            project_ids=[project_id], defer_key_issuance=True,
        )
        await TeamMemberRepository(db, org_id).apply_anchor_update(agent, {"runtime_type": RUNTIME_TYPES[choices[role]]})
        role_member[role] = agent.id

    members: list[dict] = []
    for stage in agent_stages:
        role = stage_role(definition, stage)
        human = role in human_roles
        members.append({
            "stage": stage, "role": role, "member_id": str(role_member[role]), "kind": "human" if human else "agent",
            "runtime": None if human else choices[role],
        })
        await upsert_role_binding(
            db, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage, target="agent",
            value_id=role_member[role], actor_id=user_id,
        )

    setup.org_id = org_id
    setup.project_id = project_id
    setup.event_definition_key = definition.key
    setup.confirmed_by = user_id
    setup.confirmed_at = _now()
    setup.members = members
    setup.workdir_hint = workdir_hint
    await db.flush()

    from app.repositories.story import StoryRepository
    from app.services.onboarding_funnel import emit_onboarding_event

    story = await StoryRepository(db, org_id).create(project_id=project_id, title=(definition.name or definition.key)[:500])
    await emit_onboarding_event(
        db, EVENT_CONFIRMED, session_id=setup.id, org_id=org_id, project_id=project_id,
        meta={
            "flow": "desktop_setup", "human_hand": True, "agents": len({m["member_id"] for m in members if m["kind"] == "agent"}),
            "work_item_id": str(story.id),  # the setup's first work item (the status read shows it)
        },
    )
    # last: its message commit is the confirmation's one commit (see _publish_first_stage)
    await _publish_first_stage(db, org_id=org_id, story_id=story.id, definition=definition, auth=auth, background_tasks=background_tasks)
    return setup.id, members, story.id


async def _publish_first_stage(
    db: AsyncSession, *, org_id: uuid.UUID, story_id: uuid.UUID, definition, auth, background_tasks,
) -> None:
    """PO 08:22Z — the first work item, in the confirmation's transaction: a story (title = the recipe's name, made by the caller) and the recipe's
    first stage published on it by the confirming person, through the same publish core and checks as the board's «Start»
    (`_publish_registry_event_core`, stage_origin «member»). A recipe run is keyed by its work item, so a publish without one
    would cut progress and stage hand-offs; publishing from a second browser call could leave a half setup if the window
    closed in between.

    The publish is the **last** write of the confirmation and its message commit is the confirmation's one commit: a person's
    message cannot join a caller's transaction (`send_message_core(after_commit=…)` is for server-issued messages — a person's
    message runs the `process_event` hook on the committed session), so instead nothing else is written after it. Any failure
    before that commit raises out of here and the caller rolls everything back (agents · bindings · story · the code's state);
    nothing is swallowed, so no SAVEPOINT. The deliveries it registers run on the request's `background_tasks`, after the
    response. A recipe without stages gets its story and no publish (the caller commits)."""
    from fastapi import BackgroundTasks

    from app.routers.events import _publish_registry_event_core

    stages = ((definition.payload_schema or {}).get("properties") or {}).get("stage", {}).get("enum") or []
    if stages:
        await _publish_registry_event_core(
            db, org_id, auth, definition.key,
            {"work_item_type": "story", "work_item_id": str(story_id), "stage": stages[0]},
            background_tasks if background_tasks is not None else BackgroundTasks(), stage_origin="member",
        )


@dataclass
class Exchanged:
    setup_id: uuid.UUID
    agents: list[dict]
    workdir_hint: str | None
    recipe_name: str | None
    org_name: str | None


async def exchange_setup(db: AsyncSession, *, code: str, verifier: str) -> Exchanged | None:
    """None = not confirmed yet (pending). Checks the verifier before anything else about the code, so a code seen in an
    address bar tells nothing without it. A wrong verifier does not burn the code (256-bit verifier: nothing to guess, and
    burning would let anyone who saw the address cancel the person's setup)."""
    from app.repositories.api_key import ApiKeyRepository
    from app.services.mcp_toolset import ALL_GROUPS

    setup = await _setup_by_code(db, code)
    if not _VERIFIER_RE.match(verifier) or not hmac.compare_digest(
        setup.code_challenge.encode(), pkce_challenge_from_verifier(verifier).encode()
    ):
        raise DesktopSetupError("verifier_mismatch")
    if setup.exchanged_at is not None or setup.revoked_at is not None:
        raise DesktopSetupError("code_used")
    if _now() >= setup.expires_at:
        raise DesktopSetupError("code_expired")
    if setup.confirmed_at is None:
        return None

    api_url, mcp_url = exchange_urls()
    if not mcp_url or not api_url:
        # no configured address to hand over: an agent would run without its tools, or against a wrong server — refuse before
        # any key exists (PO 08:31Z ③ · 09:45Z)
        raise DesktopSetupError("service_unavailable", "the MCP or API address is not configured")

    # one key per new agent (a role's agent appears once per stage in `members`)
    per_agent: dict[str, dict] = {}
    for m in setup.members or []:
        if m["kind"] != "agent":
            continue
        entry = per_agent.setdefault(m["member_id"], {"member_id": m["member_id"], "role": m.get("role") or m["stage"], "stages": [], "runtime": m["runtime"]})
        entry["stages"].append(m["stage"])
    agents: list[dict] = []
    for entry in per_agent.values():
        _key, plaintext = await ApiKeyRepository(db).create(
            team_member_id=uuid.UUID(entry["member_id"]), scope=list(ALL_GROUPS), expires_at=None, desktop_setup_id=setup.id,
        )
        agents.append({**entry, "api_key": plaintext})
    setup.exchanged_at = _now()
    setup.keys_issued = len(agents)
    await db.flush()
    from app.services.onboarding_funnel import emit_onboarding_event

    # no key material in the event: the counts only (the record path refuses a key-shaped string anyway)
    await emit_onboarding_event(
        db, EVENT_EXCHANGED, session_id=setup.id, org_id=setup.org_id, project_id=setup.project_id,
        meta={"flow": "desktop_setup", "keys": len(agents)},
    )
    from app.models.organization import Organization

    # the org the desktop is now joined to (Qadir 4825): the app shows it, so a person notices a setup confirmed by another org
    org_name = (await db.execute(select(Organization.name).where(Organization.id == setup.org_id))).scalar_one_or_none()
    return Exchanged(
        setup_id=setup.id, agents=agents, workdir_hint=setup.workdir_hint, recipe_name=await _recipe_name(db, setup), org_name=org_name,
    )


async def _recipe_name(db: AsyncSession, setup: DesktopSetup) -> str | None:
    """The recipe's display name (PO 08:22Z — the app's default folder ~/Sprintable/{recipe}). The org's own definition wins
    over a preset with the same key, as in the publish path."""
    from app.models.event_definition import EventDefinition

    if not setup.event_definition_key:
        return None
    return (await db.execute(
        select(EventDefinition.name).where(
            EventDefinition.key == setup.event_definition_key,
            (EventDefinition.org_id == setup.org_id) | (EventDefinition.org_id.is_(None)),
        ).order_by(EventDefinition.org_id.is_(None)).limit(1)
    )).scalar_one_or_none()


async def revoke_setup(db: AsyncSession, *, setup_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID) -> int:
    """«Disconnect this device»: every key this setup handed out, and only those. Returns how many were active."""
    from app.services.project_auth import is_org_owner_or_admin

    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id).with_for_update()
    )).scalar_one_or_none()
    if setup is None:
        raise DesktopSetupError("setup_not_found")
    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    now = _now()
    revoked = (await db.execute(
        update(ApiKey).where(ApiKey.desktop_setup_id == setup.id, ApiKey.revoked_at.is_(None))
        .values(revoked_at=now).returning(ApiKey.id)
    )).scalars().all()
    if setup.revoked_at is None:
        setup.revoked_at = now
        setup.revoked_by = user_id
    await db.flush()
    return len(revoked)


def setup_state(setup: DesktopSetup, now: datetime | None = None) -> str:
    """What the web list shows for a confirmed setup: disconnected · handed_over · waiting_for_app (confirmed, the app has not
    picked the keys up yet) · not_handed_over (the code ran out first — its agents have no key; «disconnect» clears it)."""
    if setup.revoked_at is not None:
        return "disconnected"
    if setup.exchanged_at is not None:
        return "handed_over"
    return "waiting_for_app" if (now or _now()) < setup.expires_at else "not_handed_over"


async def list_setups(db: AsyncSession, *, user_id: uuid.UUID, org_id: uuid.UUID) -> list[dict]:
    """The org's confirmed setups, newest first, with how many of each one's keys are still active (org owner/admin)."""
    from sqlalchemy import func

    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    rows = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.org_id == org_id, DesktopSetup.confirmed_at.isnot(None))
        .order_by(DesktopSetup.confirmed_at.desc()).limit(200)
    )).scalars().all()
    active = dict((await db.execute(
        select(ApiKey.desktop_setup_id, func.count()).where(
            ApiKey.desktop_setup_id.in_([r.id for r in rows]), ApiKey.revoked_at.is_(None),
        ).group_by(ApiKey.desktop_setup_id)
    )).all()) if rows else {}
    now = _now()
    return [{
        "setup_id": r.id, "device_name": r.device_name, "state": setup_state(r, now), "project_id": r.project_id,
        "recipe_key": r.event_definition_key, "confirmed_by": r.confirmed_by, "confirmed_at": r.confirmed_at,
        "exchanged_at": r.exchanged_at, "revoked_at": r.revoked_at, "keys_issued": r.keys_issued,
        "active_keys": active.get(r.id, 0),
        "members": [{k: m.get(k) for k in ("stage", "role", "member_id", "kind", "runtime")} for m in (r.members or [])],
    } for r in rows]


async def setup_hands(db: AsyncSession, *, setup_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID) -> dict:
    """story #4426 ② — one line for one setup: how many times a person had to act, minutes from the code to the first result
    the person saw, how many docs they opened. None where the step has not happened yet (never a guessed number)."""
    from sqlalchemy import func

    from app.models.onboarding_event import OnboardingEvent
    from app.services.project_auth import is_org_owner_or_admin

    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id)
    )).scalar_one_or_none()
    if setup is None:
        raise DesktopSetupError("setup_not_found")
    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    rows = (await db.execute(
        select(OnboardingEvent.event, OnboardingEvent.meta, OnboardingEvent.server_ts)
        .where(OnboardingEvent.session_id == setup_id).order_by(OnboardingEvent.server_ts)
    )).all()
    hands = sum(1 for _e, meta, _t in rows if (meta or {}).get("human_hand") is True)
    started = next((t for e, _m, t in rows if e == EVENT_CODE_ISSUED), None)
    first_result = next((t for e, _m, t in rows if e == EVENT_FIRST_RESULT), None)
    minutes = round((first_result - started).total_seconds() / 60, 1) if started and first_result else None
    return {
        "setup_id": setup_id, "human_hands": hands, "minutes_to_first_result": minutes,
        "docs_opened": sum(1 for e, _m, _t in rows if e == EVENT_DOC_OPENED),
    }


async def setup_status(db: AsyncSession, *, setup_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID) -> dict:
    """PO 08:31Z — one read for the web's progress line, the folder-fallback notice and failure ⑥: the setup's state and the
    signals read from its events (session_id = the setup id). A signal that has not happened is None, never guessed."""
    from app.models.onboarding_event import OnboardingEvent
    from app.services.project_auth import is_org_owner_or_admin

    setup = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.id == setup_id, DesktopSetup.org_id == org_id)
    )).scalar_one_or_none()
    if setup is None:
        raise DesktopSetupError("setup_not_found")
    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise DesktopSetupError("not_org_admin")
    rows = (await db.execute(
        select(OnboardingEvent.event, OnboardingEvent.meta, OnboardingEvent.server_ts)
        .where(OnboardingEvent.session_id == setup_id).order_by(OnboardingEvent.server_ts)
    )).all()

    def first(name: str):
        return next(((meta or {}, at) for e, meta, at in rows if e == name), None)

    def last(name: str):
        return next(((meta or {}, at) for e, meta, at in reversed(rows) if e == name), None)

    confirmed = first(EVENT_CONFIRMED)
    tools: dict[str, datetime] = {}
    for e, meta, at in rows:
        if e == EVENT_TOOLS_CONNECTED and (meta or {}).get("member_id"):
            tools.setdefault(str(meta["member_id"]), at)
    blocked = last(EVENT_BLOCKED)
    fallback = last(EVENT_WORKDIR_FALLBACK)
    handed = first(EVENT_FIRST_TASK_HANDED)
    result = first(EVENT_FIRST_RESULT)
    reason = (blocked[0].get("reason") if blocked else None)
    return {
        "setup_id": setup.id, "device_name": setup.device_name, "state": setup_state(setup),  # only a confirmed setup belongs to an org (an unconfirmed one is «not found»)
        "recipe_name": await _recipe_name(db, setup),
        "work_item_id": (confirmed[0].get("work_item_id") if confirmed else None),
        "members": [{k: m.get(k) for k in ("stage", "role", "member_id", "kind", "runtime")} for m in (setup.members or [])],
        "signals": {
            "tools_connected": [{"member_id": k, "at": v} for k, v in tools.items()],
            "first_task_handed_at": handed[1] if handed else None,
            "first_result_at": result[1] if result else None,
            "workdir_fallback_at": fallback[1] if fallback else None,
            "blocked": {"at": blocked[1], "reason": reason if isinstance(reason, str) else None} if blocked else None,
        },
    }


async def _mark_once(s: AsyncSession, *, setup_id: uuid.UUID, member_id: uuid.UUID, event: str) -> None:
    """One `event` row per setup · member (an advisory lock keeps two concurrent first writes to one row)."""
    from sqlalchemy import func

    from app.models.onboarding_event import OnboardingEvent
    from app.services.onboarding_funnel import record_onboarding_event

    await s.execute(select(func.pg_advisory_xact_lock(func.hashtext(f"{event}:{setup_id}:{member_id}"))))
    seen = (await s.execute(
        select(OnboardingEvent.id).where(
            OnboardingEvent.session_id == setup_id, OnboardingEvent.event == event,
            OnboardingEvent.meta["member_id"].astext == str(member_id),
        ).limit(1)
    )).first()
    if seen is None:
        await record_onboarding_event(
            s, event=event, session_id=setup_id, agent_id=member_id,
            meta={"flow": "desktop_setup", "member_id": str(member_id)},
        )


async def mark_tools_connected(api_key_id) -> None:
    """`desktop_tools_connected` (session_id = the setup · meta.member_id) the first time a key handed out by a desktop setup
    fetches the MCP manifest. Once per setup · member. Own short session; any failure is logged, never raised — the manifest
    answer must not depend on this."""
    import logging

    from app.core.database import async_session_factory

    try:
        key_id = uuid.UUID(str(api_key_id))
    except (TypeError, ValueError):
        return
    try:
        async with async_session_factory() as s:
            row = (await s.execute(
                select(ApiKey.desktop_setup_id, ApiKey.team_member_id).where(ApiKey.id == key_id)
            )).first()
            if row is None or row[0] is None:
                return
            await _mark_once(s, setup_id=row[0], member_id=row[1], event=EVENT_TOOLS_CONNECTED)
            await s.commit()
    except Exception:  # noqa: BLE001 — a measurement; the manifest answer goes on
        logging.getLogger(__name__).error("desktop_tools_connected mark failed api_key_id=%s", key_id, exc_info=True)


async def mark_first_result(story_id, member_id) -> None:
    """`desktop_first_result_seen` (PO 08:44Z): the first time one of a setup's **agents** writes on that setup's first work
    item — a comment, a status change or a stage publish, whichever comes first — i.e. when its result is recorded on the
    server (what the person sees on the web). Once per setup · member. Called after the write committed, in its own session;
    a failure is logged, never raised."""
    import logging

    from app.core.database import async_session_factory
    from app.models.onboarding_event import OnboardingEvent

    if story_id is None or member_id is None:
        return
    try:
        async with async_session_factory() as s:
            setups = (await s.execute(
                select(OnboardingEvent.session_id).where(
                    OnboardingEvent.event == EVENT_CONFIRMED,
                    OnboardingEvent.meta["work_item_id"].astext == str(story_id),
                )
            )).scalars().all()
            for setup_id in setups:
                setup = await s.get(DesktopSetup, setup_id)
                agents = {m["member_id"] for m in (setup.members or []) if m.get("kind") == "agent"} if setup else set()
                if str(member_id) in agents:
                    await _mark_once(s, setup_id=setup_id, member_id=uuid.UUID(str(member_id)), event=EVENT_FIRST_RESULT)
            await s.commit()
    except Exception:  # noqa: BLE001 — a measurement; the write it follows is already done
        logging.getLogger(__name__).error("desktop_first_result_seen mark failed story_id=%s", story_id, exc_info=True)


def exchange_urls() -> tuple[str | None, str | None]:
    """The addresses the desktop app writes into its agents' config (not secrets): the API and the hosted MCP. None when the
    deployment did not set one — never the local fallback `resolve_backend_direct_url` gives other callers (Qadir 4825: an
    agent would quietly run against localhost)."""
    import os

    from app.services.agent_onboarding_config import resolve_backend_direct_url, resolve_mcp_public_url

    api = resolve_backend_direct_url() if os.environ.get("FASTAPI_URL", "").strip() else None
    return api, resolve_mcp_public_url()
