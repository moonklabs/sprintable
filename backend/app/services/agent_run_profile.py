"""story #4540 (E-DESKTOP-2 C-5) — the model and effort a desktop agent starts with.
Contract: doc «E-DESKTOP-2 C-5 — 에이전트 실행 프로필 계약» v1.1 (20764ba3).

- The runtime is `members.runtime_type` (one truth, the same field the web's runtime picker always wrote). This module adds
  the model and effort, and a `version` the daemon compares to tell «running ≠ saved» (§4).
- What the server accepts is the table below, measured on the two CLIs (민 17:39Z · Claude 2.1.288 · Codex 0.159.3) — nothing
  made up. The daemon checks the same table again (two-fold, §2).
- A change is taken from the next start on: nothing here reaches a running session, and nothing is pushed to the device
  (the daemon reads its own profile with its agent key right before a start · §4 · §5).
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.ownership import assert_agent_owner_mutable
from app.models.agent_allowed_host import AgentAllowedHost
from app.models.agent_run_profile import AgentRunProfile
from app.models.member import Member
from app.models.project import OrgMember

# the runtimes a desktop agent can have, and the name the daemon knows each by (desktop_setup.RUNTIME_TYPES, the other way)
DESKTOP_RUNTIMES = {"claude-code": "claude", "codex": "codex"}

_CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_CODEX_SOL_EFFORTS = ("low", "medium", "high", "xhigh", "max", "ultra")
_CODEX_LUNA_EFFORTS = ("low", "medium", "high", "xhigh", "max")
_CODEX_COMMON_EFFORTS = ("low", "medium", "high", "xhigh")  # what every Codex model takes

# runtime → {"models": {name: efforts}, "custom": efforts for a typed-in name or no model (the runtime's default)}.
# Codex efforts are per model (`codex debug models`); hidden slugs (gpt-reserve · codex-auto-review) are not listed.
# Listed = a start with it opens the conversation with no question (민 19:32Z · `4540-ac0/model-probe`, turn 0): gpt-5.5 is left out —
# its TUI stops at «GPT-5.5 retires on October 14, 2026 … Try new model / Use existing model» before any thread starts, so an agent
# given it would sit there. A typed-in name is still allowed (checked at its first start · 명세 C-5).
# Bracketed aliases (`opus[1m]`) are not listed — a Claude name may be typed with the «[1m]» tail (CLAUDE_MODEL_NAME below).
CATALOG: dict[str, dict[str, Any]] = {
    "claude-code": {
        "models": {"fable": _CLAUDE_EFFORTS, "opus": _CLAUDE_EFFORTS, "sonnet": _CLAUDE_EFFORTS},
        "custom": _CLAUDE_EFFORTS,
    },
    "codex": {
        "models": {
            "gpt-6.1-sol": _CODEX_SOL_EFFORTS,
            "gpt-6-astra": _CODEX_SOL_EFFORTS,
            "gpt-6-sol": _CODEX_SOL_EFFORTS,
            "gpt-6-luna": _CODEX_LUNA_EFFORTS,
            "gpt-5.6-sol": _CODEX_SOL_EFFORTS,
            "gpt-5.6-terra": _CODEX_SOL_EFFORTS,
            "gpt-5.6-luna": _CODEX_LUNA_EFFORTS,
        },
        "custom": _CODEX_COMMON_EFFORTS,
    },
}

# a typed-in model name goes on a command line: no space, quote, `=`, `;`, bracket, nor a leading `-` (§2)
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$")
# story 4540 (PO 13:10Z · 13:11Z): Claude takes its 1M-context id as the name with a «[1m]» tail (`claude-opus-5-5[1m]` — our launchers'
# value) · that one tail only, Claude only — Codex never. The same rule is the daemon's (desktop-host run-profile.ts), held to it by
# the shared vector file tests/fixtures/model-name-vectors.json (same bytes in both repos · its sha256 pinned on both sides)
CLAUDE_MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(\[1m\])?$")
MODEL_NAMES: dict[str, re.Pattern[str]] = {"claude-code": CLAUDE_MODEL_NAME, "codex": MODEL_NAME}

BULK_MAX = 50


class _Keep:
    """«그대로 두기» in a bulk change — distinct from None, which means «the runtime's default»."""

    def __repr__(self) -> str:
        return "KEEP"


KEEP: Any = _Keep()


def _reject(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def allowed_efforts(runtime: str, model: str | None) -> tuple[str, ...]:
    entry = CATALOG[runtime]
    return entry["models"].get(model, entry["custom"]) if model is not None else entry["custom"]


def check(runtime: str | None, model: str | None, effort: str | None) -> None:
    """The saved result must be one the CLI takes (§2 — judged on the result, so a model change alone can leave an effort
    the new model doesn't take: 422)."""
    if runtime not in DESKTOP_RUNTIMES:
        raise _reject(422, "runtime_not_desktop")
    if model is not None and not MODEL_NAMES[runtime].fullmatch(model):
        raise _reject(422, "invalid_model")
    if effort is not None and effort not in allowed_efforts(runtime, model):
        raise _reject(422, "invalid_effort")


def options() -> dict:
    return {
        "runtimes": [
            {
                "runtime": runtime,
                "models": [{"name": name, "efforts": list(efforts)} for name, efforts in entry["models"].items()],
                "custom_model_efforts": list(entry["custom"]),
                "model_pattern": MODEL_NAMES[runtime].pattern,
            }
            for runtime, entry in CATALOG.items()
        ],
        # the strictest (no tail) for a client that reads one pattern only — each runtime's own is in its entry
        "model_pattern": MODEL_NAME.pattern,
    }


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _view(member: Member, profile: AgentRunProfile | None) -> dict:
    return {
        "agent_id": str(member.id),
        "runtime": member.runtime_type,
        "model": profile.model if profile else None,
        "effort": profile.effort if profile else None,
        "version": profile.version if profile else 0,
        "updated_at": _iso(profile.updated_at) if profile else None,
        # story #4598 — «묻지 않고 일하기» (no row = off, as the column default)
        "unattended": bool(profile.unattended) if profile else False,
    }


async def is_active_owner(db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """story #4598 (contract v0.1 §1 · PO: «org owner + is_active만») — who may flip «묻지 않고 일하기»: an owner of the org
    (`OrgMember.role == "owner"`, the remote-control gate's rule) whose member row is active. The run profile's other fields keep
    their own rule (`may_change`: creator · owner/admin) — this one is narrower on purpose: it turns a person's questions off."""
    row = (await db.execute(
        select(OrgMember.role, Member.is_active)
        .outerjoin(Member, Member.id == OrgMember.id)
        .where(OrgMember.org_id == org_id, OrgMember.user_id == user_id, OrgMember.deleted_at.is_(None))
    )).first()
    return row is not None and row[0] == "owner" and row[1] is not False


async def _agent(db: AsyncSession, *, org_id: uuid.UUID, agent_id: uuid.UUID) -> Member:
    member = (await db.execute(
        select(Member).where(
            Member.id == agent_id, Member.org_id == org_id, Member.type == "agent", Member.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return member


async def _profile(db: AsyncSession, member_id: uuid.UUID) -> AgentRunProfile | None:
    return await db.get(AgentRunProfile, member_id)


async def may_change(db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, agent_id: uuid.UUID) -> bool:
    """The runtime PATCH's own rule (§3 ⓔ): the agent's creator or an org owner/admin, never the system agent."""
    try:
        await assert_agent_owner_mutable(agent_id, db, org_id, user_id)
    except HTTPException:
        return False
    return True


# story #4580 (Kadir 01:02Z · one rule with lane.py KEEP_ALLOW and the daemon's hook-text parser — the shared cases are
# app/services/host-rule-vectors.json): a DNS name only — lower-case labels of letters, digits and hyphens (no edge hyphen, ≤ 63),
# ≤ 253 in all, at least one dot (PO 01:13Z: one label is refused — `localhost` too), its LAST label starting with a letter (so no IP
# in any spelling: dotted, hex, octal, one integer · IPv6 has «:») and never `localhost` (`*.localhost` refused); never a wildcard,
# a port, a path, a space or a trailing dot. Upper case is folded; nothing is trimmed (lane.py matches the whole line).
HOST_RE = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def clean_host(value: str) -> str | None:
    host = (value or "").lower()
    if not HOST_RE.fullmatch(host) or host.rsplit(".", 1)[-1] == "localhost":
        return None
    return host


async def allowed_hosts(db: AsyncSession, member_id: uuid.UUID) -> list[AgentAllowedHost]:
    return list((await db.execute(
        select(AgentAllowedHost).where(AgentAllowedHost.member_id == member_id).order_by(AgentAllowedHost.host)
    )).scalars())


async def read_for_person(db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, agent_id: uuid.UUID) -> dict:
    member = await _agent(db, org_id=org_id, agent_id=agent_id)
    view = _view(member, await _profile(db, member.id))
    view["can_change"] = await may_change(db, org_id=org_id, user_id=user_id, agent_id=agent_id)
    view["can_change_unattended"] = await is_active_owner(db, org_id=org_id, user_id=user_id)  # story #4598
    # story #4580: the «허용 주소» list (web «실행» group · Yuna ④) — who added it stays on the server
    view["allowed_hosts"] = [{"host": h.host, "added_at": _iso(h.added_at)} for h in await allowed_hosts(db, member.id)]
    return view


async def read_for_daemon(db: AsyncSession, *, member: Member) -> dict:
    """The agent's own profile, read with its own key right before a start (§4) — never another agent's.

    story #4570: also its own `name` — the desktop app names the agent's board row with it at every start, so an agent attached
    to the app (#4565) shows as itself and not as its recipe row's role, and a rename reaches the app at the next start.
    """
    if member.runtime_type not in DESKTOP_RUNTIMES:
        raise _reject(409, "runtime_not_desktop")
    profile = await _profile(db, member.id)
    return {
        "name": member.name or "",
        "runtime": DESKTOP_RUNTIMES[member.runtime_type],
        "model": profile.model if profile else None,
        "effort": profile.effort if profile else None,
        "version": profile.version if profile else 0,
        "updated_at": _iso(profile.updated_at) if profile else None,
        # story #4580: the hosts this agent may connect to without asking — the daemon writes them as its folder's
        # `WebFetch(domain:<host>)` lines (and takes out the ones it wrote that are gone from here)
        "allowed_hosts": [h.host for h in await allowed_hosts(db, member.id)],
        # story #4598: on → the daemon starts the next session in the CLI's dontAsk mode — what is allowed beforehand runs, anything
        # else is skipped without a question (PO 12:1xZ: never bypass — the fences stay up) (contract v0.1 §2)
        "unattended": bool(profile.unattended) if profile else False,
    }


RUN_PROFILE_EVENT = "desktop.run_profile"


async def _event_project(db: AsyncSession, member: Member) -> uuid.UUID | None:
    """The project the trigger event is filed under. The agent stream filters by recipient and org only (agent_gateway
    `_visible_events`), so any project of the agent's reaches it; this picks the same one the other desktop events use:
    a live desktop setup that holds this agent (`desktop.remote_control`'s `setup.project_id` · `remote_control._live_devices`),
    else the agent's lowest granted project (`agent_inbox`'s default). None when it has neither — no event (events.project_id
    is required), and the daemon's 10-min check still picks the change up."""
    from app.models.desktop_setup import DesktopSetup
    from app.models.team import TeamMember
    from app.services.desktop_relay import _setup_agents
    from app.services.remote_control import _live_devices

    for setup in (await db.execute(
        select(DesktopSetup).where(*_live_devices(member.org_id)).order_by(DesktopSetup.created_at, DesktopSetup.id)
    )).scalars().all():
        if member.id in _setup_agents(setup):
            return setup.project_id
    return (await db.execute(
        select(TeamMember.project_id).where(
            TeamMember.id == member.id, TeamMember.type == "agent", TeamMember.is_active.is_(True),
        ).order_by(TeamMember.project_id).limit(1)
    )).scalar_one_or_none()


async def _emit_run_profile(db: AsyncSession, *, member_id: uuid.UUID, version: int) -> None:
    """story #4580 (C) · contract `4580/run-profile-event-contract.md`: one `desktop.run_profile` Event down the agent's own
    stream when its run profile's version moved — a trigger only: the payload is exactly {event_type, agent_id, version}
    (no hosts · no model · no effort); the daemon re-reads the profile with its own key. Same Event shape and order as
    `remote_control._wake_devices` (flush → recipient seq), in the caller's transaction (a rolled-back change sends nothing)."""
    from app.models.event import Event
    from app.services.event_seq import assign_recipient_seq

    member = (await db.execute(select(Member).where(Member.id == member_id))).scalar_one_or_none()
    if member is None or member.type != "agent":
        return
    project_id = await _event_project(db, member)
    if project_id is None:
        return
    event = Event(
        project_id=project_id, org_id=member.org_id, event_type=RUN_PROFILE_EVENT,
        source_entity_type="agent_run_profile", source_entity_id=member.id,
        recipient_id=member.id, recipient_type="agent",
        payload={"event_type": RUN_PROFILE_EVENT, "agent_id": str(member.id), "version": int(version)},
        status="pending",
    )
    db.add(event)
    await db.flush()
    await assign_recipient_seq(db, event)


async def _bump(db: AsyncSession, *, member_id: uuid.UUID, updated_by: uuid.UUID | None) -> None:
    """story #4580: the version moves on with the model and effort kept (a row made now keeps the defaults) — so the daemon's
    «running ≠ saved» check (§4) sees a change in the allowed hosts too · (C) and the daemon hears it at once."""
    now = datetime.now(timezone.utc)
    stmt = pg_insert(AgentRunProfile).values(member_id=member_id, model=None, effort=None, version=1, updated_by=updated_by, updated_at=now)
    version = (await db.execute(stmt.on_conflict_do_update(
        index_elements=[AgentRunProfile.member_id],
        set_={"version": AgentRunProfile.version + 1, "updated_by": updated_by, "updated_at": now},
    ).returning(AgentRunProfile.version))).scalar_one()
    await _emit_run_profile(db, member_id=member_id, version=version)


async def remove_allowed_host(
    db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, updated_by: uuid.UUID, agent_id: uuid.UUID, host: str,
) -> dict:
    """[빼기] (Yuna ④ · no confirmation): the run profile's own rights (§3 ⓔ) · the same host again = the same answer (idempotent;
    the version moves only when a row went)."""
    await assert_agent_owner_mutable(agent_id, db, org_id, user_id)
    member = await _agent(db, org_id=org_id, agent_id=agent_id)
    clean = clean_host(host)
    if clean is None:
        raise _reject(422, "invalid_host")
    gone = (await db.execute(
        delete(AgentAllowedHost).where(AgentAllowedHost.member_id == member.id, AgentAllowedHost.host == clean)
    )).rowcount
    if gone:
        await _bump(db, member_id=member.id, updated_by=updated_by)
    return {"host": clean, "removed": bool(gone)}


async def _save(
    db: AsyncSession, *, member_id: uuid.UUID, model: str | None, effort: str | None, updated_by: uuid.UUID | None,
    unattended: bool = False,
) -> None:
    now = datetime.now(timezone.utc)
    stmt = pg_insert(AgentRunProfile).values(
        member_id=member_id, model=model, effort=effort, unattended=unattended, version=1, updated_by=updated_by, updated_at=now,
    )
    version = (await db.execute(stmt.on_conflict_do_update(
        index_elements=[AgentRunProfile.member_id],
        set_={
            "model": model, "effort": effort, "unattended": unattended, "version": AgentRunProfile.version + 1,
            "updated_by": updated_by, "updated_at": now,
        },
    ).returning(AgentRunProfile.version))).scalar_one()
    await _emit_run_profile(db, member_id=member_id, version=version)  # story #4580 (C)


async def on_runtime_changed(db: AsyncSession, *, member_id: uuid.UUID, updated_by: uuid.UUID | None) -> None:
    """The runtime changed somewhere else (the team-members PATCH): the two CLIs name their values differently, so model and
    effort go back to the defaults and the version moves on — a Codex model must not ride along into a Claude start.
    story #4598: «묻지 않고 일하기» is not a runtime's word — it stays as it is."""
    current = await _profile(db, member_id)
    await _save(
        db, member_id=member_id, model=None, effort=None, updated_by=updated_by,
        unattended=bool(current.unattended) if current else False,
    )


async def change(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    updated_by: uuid.UUID,
    agent_ids: list[uuid.UUID],
    runtime: Any,
    model: Any,
    effort: Any,
    unattended: Any = KEEP,
    actor_is_owner: bool = False,
) -> list[dict]:
    """One agent or many — all or nothing (§3): every agent is checked (rights, then the saved result) before anything is
    written. `KEEP` leaves a field as it is; None means the runtime's default.

    story #4598: `unattended` (a bool, or KEEP) — a change of it is an org owner's only (`actor_is_owner` = `is_active_owner`):
    anyone else changing it gets 403 `owner_required` and nothing of the body is written, even its model · effort (all or
    nothing). The current value sent again is not a change of it. The same value moves no version."""
    if not agent_ids or len(agent_ids) > BULK_MAX:
        raise _reject(422, "invalid_agent_ids")
    if unattended is not KEEP and not isinstance(unattended, bool):
        raise _reject(422, "invalid_unattended")
    ids = list(dict.fromkeys(agent_ids))
    for agent_id in ids:  # rights first — 404 · 403 · 409 SYSTEM_PUBLISHER_RESERVED, nothing written
        await assert_agent_owner_mutable(agent_id, db, org_id, user_id)
    members = [await _agent(db, org_id=org_id, agent_id=agent_id) for agent_id in ids]
    profiles = {m.id: await _profile(db, m.id) for m in members}

    if unattended is not KEEP and not actor_is_owner:
        for member in members:  # story #4598: the switch is an owner's — before the plan, before any write
            current = profiles[member.id]
            if unattended != (bool(current.unattended) if current else False):
                raise _reject(403, "owner_required")

    if runtime is KEEP and (model is not KEEP or effort is not KEEP) and len({m.runtime_type for m in members}) > 1:
        raise _reject(422, "mixed_runtime")  # model · effort only among the same runtime (the names differ)

    plan: list[tuple[Member, str, str | None, str | None, bool]] = []
    for member in members:
        current = profiles[member.id]
        new_runtime = member.runtime_type if runtime is KEEP else runtime
        runtime_changed = new_runtime != member.runtime_type
        base_model = None if runtime_changed or current is None else current.model
        base_effort = None if runtime_changed or current is None else current.effort
        new_model = base_model if model is KEEP else model
        new_effort = base_effort if effort is KEEP else effort
        new_unattended = (bool(current.unattended) if current else False) if unattended is KEEP else unattended
        check(new_runtime, new_model, new_effort)
        plan.append((member, new_runtime, new_model, new_effort, new_unattended))

    for member, new_runtime, new_model, new_effort, new_unattended in plan:
        current = profiles[member.id]
        unchanged = (
            new_runtime == member.runtime_type
            and new_model == (current.model if current else None)
            and new_effort == (current.effort if current else None)
            and new_unattended == (bool(current.unattended) if current else False)
        )
        if unchanged:
            continue  # the same PUT again moves no version (nothing to restart for)
        if new_runtime != member.runtime_type:
            member.runtime_type = new_runtime
        await _save(db, member_id=member.id, model=new_model, effort=new_effort, updated_by=updated_by, unattended=new_unattended)
    await db.flush()

    views = []
    for member in members:
        await db.refresh(member)
        profile = await _profile(db, member.id)
        if profile is not None:
            await db.refresh(profile)
        views.append(_view(member, profile))
    return views
