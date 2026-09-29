"""story #4424 — desktop setup in one go: the desktop app asks for a setup code, a person confirms the recipe on the web,
the app exchanges the code once for its agents' keys. No key is copied or pasted by a person.

Contract (PO 07:15Z · 07:21Z · PO decision on when keys are made — the plaintext is born in the exchange answer only):
- create (no login): `{challenge, device_name}` → a one-time code (256-bit, only its sha256 stored), 10 minutes.
- confirm (a person, org owner/admin — never an agent key): one transaction — for every agent stage of the recipe a **new**
  agent (role member · no key yet) or, for a stage declared `human` in `role_actor_kinds`, the confirming person; the stage is
  bound (the same upsert as the recipe apply API). Channel/connector stages are left for later («connect later»).
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
# the desktop app's runtime ids → members.runtime_type (the values the rest of the product uses)
RUNTIME_TYPES = {"claude": "claude-code", "codex": "codex"}
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")  # base64url(sha256) without padding
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")  # RFC 7636 §4.1


class DesktopSetupError(Exception):
    """A closed code: request_invalid · code_not_found · code_expired · code_used · code_not_confirmed_yet · verifier_mismatch ·
    already_confirmed · not_org_admin · recipe_not_found · roles_invalid · human_stage_needs_member · setup_not_found."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def create_setup_code(db: AsyncSession, *, challenge: str, device_name: str) -> tuple[str, datetime]:
    if not _CHALLENGE_RE.match(challenge):
        raise DesktopSetupError("request_invalid", "challenge must be base64url(sha256(verifier)) without padding")
    name = device_name.strip()[:80]
    if not name:
        raise DesktopSetupError("request_invalid", "device_name is required")
    code = secrets.token_urlsafe(32)
    expires_at = _now() + SETUP_CODE_TTL
    db.add(DesktopSetup(code_hash=_hash(code), code_challenge=challenge, device_name=name, expires_at=expires_at))
    await db.flush()
    return code, expires_at


async def _setup_by_code(db: AsyncSession, code: str) -> DesktopSetup:
    row = (await db.execute(
        select(DesktopSetup).where(DesktopSetup.code_hash == _hash(code)).with_for_update()
    )).scalar_one_or_none()
    if row is None:
        raise DesktopSetupError("code_not_found")
    return row


@dataclass
class RoleChoice:
    stage: str
    runtime: str


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
) -> tuple[uuid.UUID, list[dict]]:
    """Returns (setup_id, members). Writes only through `db` and never commits — the caller commits, or rolls back on any
    error so nothing of a half-made setup stays."""
    from app.models.event_definition import EventDefinition
    from app.repositories.team_member import TeamMemberRepository
    from app.services.member_resolver import resolve_member
    from app.services.org_agent import create_org_level_agent
    from app.services.project_auth import is_org_owner_or_admin, require_project_access
    from app.services.recipe_role_bindings import stage_target, upsert_role_binding

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

    agent_stages = [s for s in definition.stage_metadata if stage_target(definition, s) == "agent"]
    kinds = definition.role_actor_kinds or {}
    human_stages = {s for s in agent_stages if kinds.get(s) == "human"}
    choices: dict[str, str] = {}
    for r in roles:
        if r.stage in choices or r.stage not in agent_stages or r.stage in human_stages or r.runtime not in RUNTIME_TYPES:
            raise DesktopSetupError("roles_invalid", f"stage {r.stage!r} / runtime {r.runtime!r}")
        choices[r.stage] = r.runtime
    missing = [s for s in agent_stages if s not in human_stages and s not in choices]
    if missing:
        raise DesktopSetupError("roles_invalid", f"a runtime is needed for: {missing}")

    person_member_id: uuid.UUID | None = None
    if human_stages:
        try:
            person_member_id = uuid.UUID(str((await resolve_member(auth, org_id, db, project_id)).id))
        except Exception as exc:  # noqa: BLE001 — no member row in this project for the person: say so, don't guess
            raise DesktopSetupError("human_stage_needs_member") from exc

    members: list[dict] = []
    for stage in agent_stages:  # the recipe's own order
        if stage in human_stages:
            member_id = person_member_id
            members.append({"stage": stage, "member_id": str(member_id), "kind": "human", "runtime": None})
        else:
            if settings.is_ee_enabled:
                from ee.plan_limits import check_agent_add_limit  # type: ignore[import]

                await check_agent_add_limit(db, org_id)  # an HTTPException(402) here rolls the whole setup back
            agent, _no_key = await create_org_level_agent(
                db, org_id=org_id, created_by=user_id, name=f"{stage} · {setup.device_name}"[:120], role="member",
                project_ids=[project_id], defer_key_issuance=True,
            )
            await TeamMemberRepository(db, org_id).apply_anchor_update(agent, {"runtime_type": RUNTIME_TYPES[choices[stage]]})
            member_id = agent.id
            members.append({"stage": stage, "member_id": str(member_id), "kind": "agent", "runtime": choices[stage]})
        await upsert_role_binding(
            db, org_id=org_id, project_id=project_id, definition_key=definition.key, stage=stage, target="agent",
            value_id=member_id, actor_id=user_id,
        )

    setup.org_id = org_id
    setup.project_id = project_id
    setup.event_definition_key = definition.key
    setup.confirmed_by = user_id
    setup.confirmed_at = _now()
    setup.members = members
    await db.flush()
    return setup.id, members


@dataclass
class Exchanged:
    setup_id: uuid.UUID
    agents: list[dict]


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

    agents: list[dict] = []
    for m in setup.members or []:
        if m["kind"] != "agent":
            continue
        _key, plaintext = await ApiKeyRepository(db).create(
            team_member_id=uuid.UUID(m["member_id"]), scope=list(ALL_GROUPS), expires_at=None, desktop_setup_id=setup.id,
        )
        agents.append({"member_id": m["member_id"], "stage": m["stage"], "runtime": m["runtime"], "api_key": plaintext})
    setup.exchanged_at = _now()
    setup.keys_issued = len(agents)
    await db.flush()
    return Exchanged(setup_id=setup.id, agents=agents)


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


def exchange_urls() -> tuple[str, str | None]:
    """The addresses the desktop app writes into its agents' config (not secrets): the API and the hosted MCP."""
    from app.services.agent_onboarding_config import resolve_backend_direct_url, resolve_mcp_public_url

    return resolve_backend_direct_url(), resolve_mcp_public_url()
