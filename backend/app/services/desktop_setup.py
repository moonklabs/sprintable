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

from fastapi import HTTPException
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
EVENT_FIRST_SCREEN_INPUT = "desktop_first_screen_human_input"
# PO 12:49Z — the reasons the desktop app actually sends for «blocked», taken from the sender: today only the company-managed
# MCP policy (shell 4427, PR 184 `setup-flow.ts:160` found · `:237` after_start). A new reason is added here together with
# the shell change that sends it. Anything else is dropped (the web never shows free text as a reason).
BLOCKED_REASONS = frozenset({"managed_mcp"})
BLOCKED_RUNTIMES = frozenset({"claude", "codex"})
BLOCKED_WHEN = frozenset({"found", "after_start"})  # seen while finding the runtime · the session ended right after start
EVENT_DOC_OPENED = "desktop_doc_opened"
# story #4433 (Min 11:55Z) — sent by the desktop app: an agent's session ended early · the person restarted it
EVENT_AGENT_ENDED_EARLY = "desktop_agent_ended_early"
EVENT_AGENT_RESTARTED = "desktop_agent_restarted"
_EXIT_CODE_RANGE = range(-(2**31), 2**31)
# the desktop app's runtime ids → members.runtime_type (the values the rest of the product uses)
RUNTIME_TYPES = {"claude": "claude-code", "codex": "codex"}
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # base64url(sha256) without padding
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")  # RFC 7636 §4.1


class DesktopSetupError(Exception):
    """A closed code: request_invalid · service_unavailable · code_not_found · code_expired · code_used · code_not_confirmed_yet · verifier_mismatch ·
    already_confirmed · not_org_admin · recipe_not_found · roles_invalid · recipe_too_large · no_agent_role · human_stage_needs_member ·
    setup_not_found · has_organization · pending_invites (story 4427 (나): the new-organization path)."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_setup_code(db: AsyncSession, *, challenge: str, device_name: str) -> tuple[str, datetime, uuid.UUID, str]:
    if not _CHALLENGE_RE.match(challenge):
        raise DesktopSetupError("request_invalid", "challenge must be base64url(sha256(verifier)) without padding")
    name = device_name.strip()[:80]
    if not name:
        raise DesktopSetupError("request_invalid", "device_name is required")
    from app.services.onboarding_funnel import emit_onboarding_event

    code = secrets.token_urlsafe(32)
    # PO 12:21Z — the app's step events prove their setup with this; only its hash is kept
    event_token = secrets.token_urlsafe(32)
    expires_at = _now() + SETUP_CODE_TTL
    setup = DesktopSetup(
        code_hash=_hash(code), code_challenge=challenge, device_name=name, expires_at=expires_at,
        event_token_hash=_hash(event_token),
    )
    db.add(setup)
    await db.flush()
    await emit_onboarding_event(db, EVENT_CODE_ISSUED, session_id=setup.id, meta={"flow": "desktop_setup"})
    # the setup id is not a secret (nothing can be done with it without an admin session); the app passes it to the web page
    # so steps before the confirmation (a sign-in) can be keyed by it (PO 08:31Z)
    return code, expires_at, setup.id, event_token


async def verify_setup_event(
    db: AsyncSession, *, event: str, setup_id: uuid.UUID | None, event_token: str | None, user_id: uuid.UUID | None,
) -> bool:
    """Is this step event proven for its setup (PO 12:21Z)? A desktop app name: the header token matches the setup's hash
    (constant time). A web name: sent by a signed-in member of the setup's org. Anything else — or no such setup — is not."""
    from app.services.onboarding_funnel import DESKTOP_SHELL_EMIT_EVENTS, FE_EMIT_EVENTS

    if setup_id is None or not event.startswith("desktop_"):
        return False  # only the desktop setup's own step names are ever counted by the setup reads
    setup = (await db.execute(
        select(DesktopSetup.event_token_hash, DesktopSetup.org_id, DesktopSetup.revoked_at).where(DesktopSetup.id == setup_id)
    )).first()
    if setup is None:
        return False
    token_hash, org_id, revoked_at = setup
    if event in DESKTOP_SHELL_EMIT_EVENTS:
        # PO 12:51Z — no time limit; the token ends when the setup is disconnected (DELETE)
        if revoked_at is not None:
            return False
        return bool(event_token and token_hash and hmac.compare_digest(_hash(event_token).encode(), token_hash.encode()))
    if event in FE_EMIT_EVENTS and user_id is not None and org_id is not None:
        from app.models.project import OrgMember

        member = (await db.execute(
            select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id, OrgMember.deleted_at.is_(None))
        )).first()
        return member is not None
    return False


async def _active_agent_count(db: AsyncSession, org_id: uuid.UUID) -> int:
    """The org's active agents — the same count the plan limit uses (ee/plan_limits.check_agent_add_limit, read only)."""
    from sqlalchemy import text

    return int((await db.execute(
        text("SELECT COUNT(*) FROM members WHERE org_id = :oid AND type = 'agent' AND is_active = true AND deleted_at IS NULL"),
        {"oid": str(org_id)},
    )).scalar() or 0)


def _with_setup_numbers(exc: HTTPException, *, needed: int, agents_before: int) -> HTTPException:
    """PO 12:30Z — the plan limit's 402 with two numbers the web's limit screen reads: `needed` (new agents this setup makes)
    and `available` (the limit minus the agents there were before this setup, not below 0). The limit's own `current` counts
    the agents this confirmation had already made, so limit − current is never above 0. Numbers only — no plan, price or
    upgrade text; ee/plan_limits is not changed."""
    detail = exc.detail if isinstance(exc.detail, dict) else None
    if exc.status_code != 402 or not detail or detail.get("code") != "PLAN_LIMIT_EXCEEDED":
        return exc
    limit = detail.get("limit")
    available = max(0, int(limit) - agents_before) if isinstance(limit, int) else None
    return HTTPException(status_code=402, detail={**detail, "needed": needed, "available": available}, headers=exc.headers)


async def _setup_by_code(db: AsyncSession, code: str) -> DesktopSetup:
    row = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.code_hash == _hash(code)).with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopSetupError("code_not_found")
    return row


@dataclass
class RoleChoice:
    """One row of the confirmation body: a runtime (an agent is made for the role) or owner «me» (the person confirming holds
    it — only for an either row, Qadir 4834 · PO 05:21Z decision ⒜)."""
    role: str
    runtime: str | None = None
    owner: str | None = None


@dataclass
class RoleBinding:
    """Who holds each setup row: the person confirming (human rows and either rows chosen as «me») or a new agent on a
    runtime. `order` is the recipe's own role order."""
    order: list[str]
    person_roles: set[str]
    agent_runtimes: dict[str, str]


# the product's limits for one setup (PO 06:04Z: judged here with recipe_too_large, not by the request schema)
SETUP_MAX_ROLES = 50
SETUP_ROLE_NAME_MAX = 200


def bind_setup_roles(rows: list[dict], roles: list[RoleChoice]) -> RoleBinding:
    """The one place a confirmation body is checked against a recipe's setup rows (`setup_role_rows`) — every confirmation
    route uses it. A human row is never sent (it is the person); an agent row needs a runtime; an either row takes a runtime or
    owner «me». Anything else (an unknown or repeated role, a human row sent, «me» on an agent row, both or neither of runtime
    and owner, a row left out) → roles_invalid. When no row is left for an agent → no_agent_role: the setup exists to start
    agents on this device (a person-only flow makes none). More rows than SETUP_MAX_ROLES or a role name longer than
    SETUP_ROLE_NAME_MAX (in the body or the recipe) → recipe_too_large."""
    if len(roles) > SETUP_MAX_ROLES or len(rows) > SETUP_MAX_ROLES or any(
        len(r.role) > SETUP_ROLE_NAME_MAX for r in roles
    ) or any(len(r["role"]) > SETUP_ROLE_NAME_MAX for r in rows):
        raise DesktopSetupError("recipe_too_large", f"up to {SETUP_MAX_ROLES} roles of up to {SETUP_ROLE_NAME_MAX} characters")
    order = [r["role"] for r in rows]
    kind = {r["role"]: r["kind"] for r in rows}
    person = {r["role"] for r in rows if r["kind"] == "human"}
    runtimes: dict[str, str] = {}
    seen: set[str] = set()
    for r in roles:
        k = kind.get(r.role)
        if r.role in seen or k is None or k == "human":
            raise DesktopSetupError("roles_invalid", f"role {r.role!r}")
        seen.add(r.role)
        if r.owner is not None and r.runtime is not None:
            raise DesktopSetupError("roles_invalid", f"role {r.role!r}: a runtime or owner, not both")
        if r.owner == "me" and k == "either":
            person.add(r.role)
        elif r.owner is None and r.runtime in RUNTIME_TYPES:
            runtimes[r.role] = r.runtime
        else:
            raise DesktopSetupError("roles_invalid", f"role {r.role!r} / runtime {r.runtime!r} / owner {r.owner!r}")
    missing = [role for role in order if role not in person and role not in runtimes]
    if missing:
        raise DesktopSetupError("roles_invalid", f"a runtime is needed for: {missing}")
    if not runtimes:
        raise DesktopSetupError("no_agent_role", "every row is the person's — the setup starts at least one agent")
    return RoleBinding(order=order, person_roles=person, agent_runtimes=runtimes)


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


def setup_role_rows(definition) -> list[dict]:
    """PO 16:03Z — the one place a recipe's setup rows are worked out: one row per role that holds an agent-target stage, in the
    recipe's order, `{role, kind, stages}`. kind = the role's `role_actor_kinds` value (human · agent · either; none declared →
    agent). The confirmation checks against these rows and `GET /desktop/recipes` hands them to the web — the web no longer
    works them out itself. A human row is bound to the person confirming; an agent row needs a runtime; an either row takes a
    runtime or owner «me» (bind_setup_roles)."""
    kinds = definition.role_actor_kinds or {}  # keyed by role (events.py reads it the same way)
    rows: list[dict] = []
    by_role: dict[str, dict] = {}
    for s in ordered_agent_stages(definition):
        role = stage_role(definition, s)
        if role not in by_role:
            kind = kinds.get(role)
            by_role[role] = {"role": role, "kind": kind if kind in ("human", "agent", "either") else "agent", "stages": []}
            rows.append(by_role[role])
        by_role[role]["stages"].append(s)
    return rows


def recipe_startable(definition) -> bool:
    """A recipe the desktop setup can start: enabled, a flow (the payload's stage enum), a screen name and at least one row that
    becomes an agent (human-only recipes make no agent on this device)."""
    stages = ((definition.payload_schema or {}).get("properties") or {}).get("stage", {}).get("enum")
    return (
        bool(definition.enabled) and isinstance(stages, list) and bool(stages) and bool((definition.name or "").strip())
        and any(r["kind"] != "human" for r in setup_role_rows(definition))
    )


async def list_setup_recipes(db: AsyncSession, *, org_id: uuid.UUID | None) -> list[dict]:
    """PO 16:03Z — the recipes this org can start from the desktop setup (platform presets ∪ this org's own, the same visibility
    as the confirmation's lookup), each with its setup rows from `setup_role_rows`.
    `org_id=None` (story 4427 (나) · PO 02:26Z — a person with no organization yet): the platform presets only, never any
    organization's own recipe — the condition is `org_id IS NULL` and nothing else."""
    from app.models.event_definition import EventDefinition

    visible = (
        EventDefinition.org_id.is_(None) if org_id is None
        else (EventDefinition.org_id == org_id) | (EventDefinition.org_id.is_(None))
    )
    definitions = (await db.execute(
        select(EventDefinition).where(visible).order_by(EventDefinition.name, EventDefinition.key)
    )).scalars().all()
    return [
        # org_id: null for a platform preset (the web names presets in the viewer's language by key — Qadir 4834)
        {"id": d.id, "key": d.key, "org_id": d.org_id, "name": d.name, "description": d.description, "roles": setup_role_rows(d)}
        for d in definitions if recipe_startable(d)
    ]


async def confirm_setup_new_org(
    db: AsyncSession,
    *,
    code: str,
    user_id: uuid.UUID,
    org_name: str,
    project_name: str,
    recipe_id: uuid.UUID,
    roles: list[RoleChoice],
    auth,
    workdir_hint: str | None = None,
    background_tasks=None,
) -> tuple[uuid.UUID, list[dict], uuid.UUID, uuid.UUID, uuid.UUID]:
    """story 4427 (나) · design doc 9a4cb445 — «시작» on the setup page for a person with no organization: the organization, its
    first project and the setup (agents · bindings · first work item) in **one transaction**. Returns (setup_id, members,
    work_item_id, org_id, project_id). Never commits itself: the confirmation's one commit is the first stage's publish, as in
    `confirm_setup`, and any error before it rolls everything back — no organization is left behind by a failed setup.

    Order (PO 02:57Z): e-mail gate → per-user lock → the code (row lock) → a replay by the same person returns what the code
    made → the code's state → no organization yet → no pending invite → owned-org limit → create → `confirm_setup` itself."""
    from app.repositories.org_invite import OrgInviteRepository
    from app.models.user import User
    from app.services.org_project_create import (
        check_owned_org_limit,
        check_project_create_allowed,
        create_org_with_owner,
        create_project_with_member,
        has_active_org,
        lock_first_org_path,
        require_verified_email_for_org,
    )

    await require_verified_email_for_org(db, str(user_id))
    await lock_first_org_path(db, user_id)
    setup = await _setup_by_code(db, code)
    # the same person pressing again after a confirmation whose answer was lost: what this code made, as it is (nothing made or
    # re-applied). The confirmation row holds the organization and project it was confirmed into.
    if setup.confirmed_at is not None and setup.confirmed_by == user_id and setup.revoked_at is None:
        return setup.id, list(setup.members or []), setup.work_item_id, setup.org_id, setup.project_id
    if setup.revoked_at is not None or setup.exchanged_at is not None:
        raise DesktopSetupError("code_used")
    if _now() >= setup.expires_at:
        raise DesktopSetupError("code_expired")
    if setup.confirmed_at is not None:
        raise DesktopSetupError("already_confirmed")

    if await has_active_org(db, user_id):
        raise DesktopSetupError("has_organization")
    # only a verified e-mail is looked up (as `GET /invites/mine`): an unverified address could be anyone's
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is not None and user.email_verified and user.email:
        if await OrgInviteRepository(db).pending_for_email(user.email, user.id):
            raise DesktopSetupError("pending_invites")
    await check_owned_org_limit(db, str(user_id))

    org = await create_org_with_owner(db, name=org_name, slug=None, user_id=str(user_id), owner_member_id=None)
    await check_project_create_allowed(db, org.id)
    project = await create_project_with_member(
        db, org_id=org.id, name=project_name, description=None, slug=None, user_id=str(user_id),
    )
    setup_id, members, work_item_id = await confirm_setup(
        db, code=code, user_id=user_id, org_id=org.id, project_id=project.id, recipe_id=recipe_id, roles=roles, auth=auth,
        workdir_hint=workdir_hint, background_tasks=background_tasks,
    )
    return setup_id, members, work_item_id, org.id, project.id


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
    # PO 11:48Z — the same person confirming the same setup again gets it as it is (200): after a confirmation whose commit
    # went through but whose answer did not (a 500 from a hook after the commit), pressing again must not look like a failure.
    # Nothing is made or re-applied (a different body changes nothing). Anyone else is still refused.
    if (
        setup.confirmed_at is not None and setup.confirmed_by == user_id and setup.org_id == org_id and setup.revoked_at is None
    ):
        return setup.id, list(setup.members or []), setup.work_item_id
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

    # the same rows GET /desktop/recipes hands the web (one function — PO 16:03Z)
    rows = setup_role_rows(definition)
    binding = bind_setup_roles(rows, roles)
    role_order = binding.order
    human_roles = binding.person_roles  # human rows and either rows chosen as «me»
    choices = binding.agent_runtimes

    person_member_id: uuid.UUID | None = None
    if human_roles:
        try:
            person_member_id = uuid.UUID(str((await resolve_member(auth, org_id, db, project_id)).id))
        except Exception as exc:  # noqa: BLE001 — no member row in this project for the person: say so, don't guess
            raise DesktopSetupError("human_stage_needs_member") from exc

    # one member per role: the person for a human role, one new agent for every other role
    role_member: dict[str, uuid.UUID] = {}
    needed = len([r for r in role_order if r not in human_roles])
    agents_before = await _active_agent_count(db, org_id) if settings.is_ee_enabled else 0
    for role in role_order:  # the recipe's own order
        if role in human_roles:
            role_member[role] = person_member_id
            continue
        if settings.is_ee_enabled:
            from ee.plan_limits import check_agent_add_limit  # type: ignore[import]

            try:
                await check_agent_add_limit(db, org_id)  # an HTTPException(402) here rolls the whole setup back
            except HTTPException as exc:
                raise _with_setup_numbers(exc, needed=needed, agents_before=agents_before) from None
        agent, _no_key = await create_org_level_agent(
            db, org_id=org_id, created_by=user_id, name=f"{role} · {setup.device_name}"[:120], role="member",
            project_ids=[project_id], defer_key_issuance=True,
        )
        await TeamMemberRepository(db, org_id).apply_anchor_update(agent, {"runtime_type": RUNTIME_TYPES[choices[role]]})
        role_member[role] = agent.id

    members: list[dict] = []
    stage_to_role = {s: r["role"] for r in rows for s in r["stages"]}
    for stage in ordered_agent_stages(definition):  # the flow's own order (the first stage is published below)
        role = stage_to_role[stage]
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
    setup.work_item_id = story.id  # the product's link (PO 11:04Z) — the funnel meta below is for analysis only
    await db.flush()
    await emit_onboarding_event(
        db, EVENT_CONFIRMED, session_id=setup.id, org_id=org_id, project_id=project_id,
        meta={
            "flow": "desktop_setup", "human_hand": True, "agents": len({m["member_id"] for m in members if m["kind"] == "agent"}),
            "work_item_id": str(story.id),  # for analysis; the product reads desktop_setups.work_item_id
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
            # stage_origin left at its default «member»: the confirming person's publish gets the board «Start» checks
            background_tasks if background_tasks is not None else BackgroundTasks(),
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


async def _recipe_ref(db: AsyncSession, setup: DesktopSetup) -> dict | None:
    """The setup's recipe as {key, name, org_id} — org_id null for a platform preset. The org's own definition wins over a
    preset with the same key, as in the publish path. The web names a preset by its translation from key + org_id, the same
    way the recipe list does (PO 10:39Z ①: one name in one flow — not the stored name on the progress screen)."""
    from app.models.event_definition import EventDefinition

    if not setup.event_definition_key:
        return None
    row = (await db.execute(
        select(EventDefinition.key, EventDefinition.name, EventDefinition.org_id).where(
            EventDefinition.key == setup.event_definition_key,
            (EventDefinition.org_id == setup.org_id) | (EventDefinition.org_id.is_(None)),
        ).order_by(EventDefinition.org_id.is_(None)).limit(1)
    )).first()
    return {"key": row.key, "name": row.name, "org_id": row.org_id} if row else None


async def _recipe_name(db: AsyncSession, setup: DesktopSetup) -> str | None:
    """The recipe's stored display name (PO 08:22Z — the app's default folder ~/Sprintable/{recipe})."""
    ref = await _recipe_ref(db, setup)
    return ref["name"] if ref else None


@dataclass
class Revoked:
    """What «disconnect» did: the keys it revoked now, and whether the device was already disconnected before this call (another
    admin first — Qadir 4830 · PO 05:48Z ④: the screen must not say «you disconnected it»). revoked_at / revoked_by are the
    setup's own, whoever it was."""
    keys: int
    already: bool
    revoked_at: datetime
    revoked_by: uuid.UUID | None


async def person_names(db: AsyncSession, org_id: uuid.UUID, user_ids: set) -> dict:
    """user id → the person's name in this org, for «connected by» / «disconnected by». A removed member (is_active false —
    Qadir 4830 ③) or a deleted row gives no name, so nobody who left is named as if still here."""
    from app.models.member import Member

    ids = {u for u in user_ids if u is not None}
    if not ids:
        return {}
    return dict((await db.execute(
        select(Member.user_id, Member.name).where(
            Member.org_id == org_id, Member.type == "human", Member.user_id.in_(ids), Member.deleted_at.is_(None),
            Member.is_active.is_(True),
        )
    )).all())


async def revoke_setup(db: AsyncSession, *, setup_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID) -> Revoked:
    """«Disconnect this device»: every key this setup handed out, and only those."""
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
    already = setup.revoked_at is not None
    if not already:
        setup.revoked_at = now
        setup.revoked_by = user_id
    await db.flush()
    return Revoked(keys=len(revoked), already=already, revoked_at=setup.revoked_at, revoked_by=setup.revoked_by)


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
    # story #4424 (Yuna's /desktop list) — «connected by {name}» · «disconnected by {name}»: the person's name in this org
    names = await person_names(db, org_id, {r.confirmed_by for r in rows} | {r.revoked_by for r in rows})
    now = _now()
    return [{
        "setup_id": r.id, "device_name": r.device_name, "state": setup_state(r, now), "project_id": r.project_id,
        "recipe_key": r.event_definition_key, "confirmed_by": r.confirmed_by, "confirmed_at": r.confirmed_at,
        "confirmed_by_name": names.get(r.confirmed_by), "revoked_by_name": names.get(r.revoked_by),
        "exchanged_at": r.exchanged_at, "revoked_at": r.revoked_at, "keys_issued": r.keys_issued,
        "active_keys": active.get(r.id, 0),
        "members": [{k: m.get(k) for k in ("stage", "role", "member_id", "kind", "runtime")} for m in (r.members or [])],
    } for r in rows]


def _counted_row():
    """PO 12:21Z — what the setup reads believe: rows the server wrote itself (its names can no longer be sent from outside)
    and client rows the server proved for this setup (0424). Others are kept for analysis but never counted."""
    from sqlalchemy import or_

    from app.models.onboarding_event import OnboardingEvent
    from app.services.onboarding_funnel import BE_EMIT_EVENTS

    return or_(OnboardingEvent.event.in_(BE_EMIT_EVENTS), OnboardingEvent.desktop_setup_verified.is_(True))


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
        .where(OnboardingEvent.session_id == setup_id, _counted_row()).order_by(OnboardingEvent.server_ts)
    )).all()
    hands = sum(1 for _e, meta, _t in rows if (meta or {}).get("human_hand") is True)
    started = next((t for e, _m, t in rows if e == EVENT_CODE_ISSUED), None)
    first_result = next((t for e, _m, t in rows if e == EVENT_FIRST_RESULT), None)
    minutes = round((first_result - started).total_seconds() / 60, 1) if started and first_result else None
    return {
        "setup_id": setup_id, "human_hands": hands, "minutes_to_first_result": minutes,
        "docs_opened": sum(1 for e, _m, _t in rows if e == EVENT_DOC_OPENED),
    }


def _agents_ended(setup: DesktopSetup, rows) -> list[dict]:
    """story #4433 (Min 11:55Z) — per agent of this setup whose session ended early: when it last ended (with the runtime and
    exit code of that report) and when the person last restarted it (None if never). Proven rows only (the caller's rows);
    a member id that is not one of this setup's agents is ignored; runtime outside claude · codex and a non-integer exit code
    are None (the web never shows free text). The setup's own agent order."""
    order: list[str] = []
    for m in setup.members or []:
        mid = str(m.get("member_id") or "")
        if m.get("kind") == "agent" and mid and mid not in order:
            order.append(mid)
    ended: dict[str, tuple[dict, datetime]] = {}
    restarted: dict[str, datetime] = {}
    for e, meta, at in rows:  # oldest first — the last write wins
        mid = str((meta or {}).get("member_id") or "")
        if mid not in order:
            continue
        if e == EVENT_AGENT_ENDED_EARLY:
            ended[mid] = (meta or {}, at)
        elif e == EVENT_AGENT_RESTARTED:
            restarted[mid] = at
    out = []
    for mid in order:
        if mid not in ended:
            continue
        meta, at = ended[mid]
        code = meta.get("exit_code")
        out.append({
            "member_id": mid, "at": at,
            "runtime": meta.get("runtime") if meta.get("runtime") in BLOCKED_RUNTIMES else None,
            "exit_code": code if isinstance(code, int) and not isinstance(code, bool) and code in _EXIT_CODE_RANGE else None,
            "restarted_at": restarted.get(mid),
        })
    return out


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
        .where(OnboardingEvent.session_id == setup_id, _counted_row()).order_by(OnboardingEvent.server_ts)
    )).all()

    def first(name: str):
        return next(((meta or {}, at) for e, meta, at in rows if e == name), None)

    def last(name: str):
        return next(((meta or {}, at) for e, meta, at in reversed(rows) if e == name), None)

    tools: dict[str, datetime] = {}
    for e, meta, at in rows:
        if e == EVENT_TOOLS_CONNECTED and (meta or {}).get("member_id"):
            tools.setdefault(str(meta["member_id"]), at)
    blocked = last(EVENT_BLOCKED)
    fallback = last(EVENT_WORKDIR_FALLBACK)
    handed = first(EVENT_FIRST_TASK_HANDED)
    result = first(EVENT_FIRST_RESULT)
    reason = (blocked[0].get("reason") if blocked else None)
    screen_input = first(EVENT_FIRST_SCREEN_INPUT)
    recipe = await _recipe_ref(db, setup)
    agents_ended = _agents_ended(setup, rows)
    return {
        "setup_id": setup.id, "device_name": setup.device_name, "state": setup_state(setup),  # only a confirmed setup belongs to an org (an unconfirmed one is «not found»)
        "recipe_name": recipe["name"] if recipe else None,
        "recipe": recipe,
        "work_item_id": str(setup.work_item_id) if setup.work_item_id else None,
        "members": [{k: m.get(k) for k in ("stage", "role", "member_id", "kind", "runtime")} for m in (setup.members or [])],
        "signals": {
            "tools_connected": [{"member_id": k, "at": v} for k, v in tools.items()],
            "first_task_handed_at": handed[1] if handed else None,
            "first_result_at": result[1] if result else None,
            "workdir_fallback_at": fallback[1] if fallback else None,
            "first_screen_human_input_at": screen_input[1] if screen_input else None,
            "agents_ended": agents_ended,
            "blocked": {
                "at": blocked[1],
                "reason": reason if reason in BLOCKED_REASONS else None,
                "runtime": blocked[0].get("runtime") if blocked[0].get("runtime") in BLOCKED_RUNTIMES else None,
                "when": blocked[0].get("when") if blocked[0].get("when") in BLOCKED_WHEN else None,
            } if blocked else None,
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


async def _setups_for_story(db: AsyncSession, story_uuid: uuid.UUID) -> list:
    """The setups whose first work item is this story (one indexed read, alembic 0423)."""
    return (await db.execute(
        select(DesktopSetup.id, DesktopSetup.members).where(DesktopSetup.work_item_id == story_uuid)
    )).all()


async def mark_first_result(story_id, member_id, *, db: AsyncSession | None = None) -> None:
    """`desktop_first_result_seen` (PO 08:44Z · 11:04Z · 11:48Z): the first time one of a setup's **agents** shows a result on
    that setup's first work item — a comment, a stage publish, or a status change to in-review/done (the status one is called
    from `emit_story_status_changed`, the single path every status change passes). Once per setup · member.

    Called after every such write in the product, so it must be cheap for everyone else: the lookup (one indexed read, 0423)
    goes through the caller's session when there is one; a session of its own is opened only when this write really is a
    setup agent's — and even then `_mark_once` keeps it to one row. A failure is logged, never raised."""
    import logging

    from app.core.database import async_session_factory

    if story_id is None or member_id is None:
        return
    try:
        story_uuid = uuid.UUID(str(story_id))
    except ValueError:
        return
    try:
        if db is not None:
            # Qadir 4826 (PO 12:08Z): some callers emit before their commit (a gate resolution · advance_story_to_done), so
            # this read runs inside their open transaction. In a savepoint: if it fails (a statement timeout…) only the
            # savepoint is rolled back and the caller's write still commits — a measurement never blocks the real write.
            async with db.begin_nested():
                setups = await _setups_for_story(db, story_uuid)
        else:
            async with async_session_factory() as s:
                setups = await _setups_for_story(s, story_uuid)
        mine = [
            setup_id for setup_id, members in setups
            if str(member_id) in {m["member_id"] for m in (members or []) if m.get("kind") == "agent"}
        ]
        if not mine:
            return
        async with async_session_factory() as s:
            for setup_id in mine:
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
