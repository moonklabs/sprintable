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

import hashlib
import re
import unicodedata
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
from app.models.agent_deployment import AgentPersona
from app.models.member import Member

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


async def read_for_person(
    db: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, agent_id: uuid.UUID, actor_is_owner: bool,
) -> dict:
    member = await _agent(db, org_id=org_id, agent_id=agent_id)
    view = _view(member, await _profile(db, member.id))
    view["can_change"] = await may_change(db, org_id=org_id, user_id=user_id, agent_id=agent_id)
    view["can_change_unattended"] = actor_is_owner  # story #4598: `member_resolver.is_active_owner`, as the PUT gates
    # story #4580: the «허용 주소» list (web «실행» group · Yuna ④) — who added it stays on the server
    view["allowed_hosts"] = [{"host": h.host, "added_at": _iso(h.added_at)} for h in await allowed_hosts(db, member.id)]
    return view


PERSONA_TEXT_MAX = 16_000        # characters of the role text the daemon is handed (the role comes first in a recruited persona, so a cut keeps it)
PERSONA_TEXT_MAX_BYTES = 32_000  # … and bytes (UTF-8): Korean is three bytes a character, so the character cap alone would let 48 KB through
PERSONA_STYLE_MAX = 2_000
PERSONA_STYLE_MAX_BYTES = 6_000   # 2,000 three-byte (Korean) characters — with the instructions' 32,000 and the sentence round them the whole stays inside the daemon's 40,000-byte session cap (pinned by test)
PERSONA_ROLE_MAX = 200
# the characters a session instruction must not carry, by Unicode category rather than a hand list (Kadir's lens, story 4680): every control (Cc — but \t and \n, which
# is how a text is written), every format character (Cf: bidi marks · embeddings · isolates · zero-width · soft hyphen · the Arabic letter mark · the deprecated
# U+206A–206F · BOM · the tag characters), the line and paragraph separators (Zl · Zp). The daemon applies the same rule (\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}).
_DROP_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})
TEXT_DROP_CATEGORIES = _DROP_CATEGORIES  # story 4784: the one list of «not text a person reads» — the setup card's name · role · folder name are refused on it too


def _strip_unsafe(text: str) -> str:
    return "".join(ch for ch in text if ch in "\t\n" or unicodedata.category(ch) not in _DROP_CATEGORIES)


def _cut_bytes(text: str, max_bytes: int) -> str:
    raw = text.encode("utf-8")
    return text if len(raw) <= max_bytes else raw[:max_bytes].decode("utf-8", "ignore").rstrip()


def _clean_persona_text(value: str | None, limit: int, max_bytes: int = PERSONA_TEXT_MAX_BYTES) -> str:
    """One filter for every piece that reaches a session instruction (the persona's text, its base persona's, its style, its name · role): CRLF → LF, the characters above
    out, trimmed, cut to `limit` characters AND `max_bytes` bytes."""
    text = _strip_unsafe((value or "").replace("\r\n", "\n").replace("\r", "\n")).strip()[:limit]
    return _cut_bytes(text, max_bytes).strip()


def _one_line(value: str | None, limit: int) -> str:
    """A role / name sits inside the daemon's fixed sentence, on one line: the same filter, line breaks and runs of blanks folded to one space."""
    return re.sub(r"\s+", " ", _clean_persona_text(value, limit, limit * 4)).strip()


def persona_text_problem(fields: dict[str, str | None]) -> str | None:
    """story 4680 AC2 (Kadir's second review): a control character (NUL above all — Postgres text cannot hold it and the write answered 500) cannot be saved, nor sent to an agent. A readable
    sentence naming the field, before anything is written. Tab, newline and carriage return are text; every other Cc is not."""
    for name, value in fields.items():
        if value and any(ch not in "\t\n\r" and unicodedata.category(ch) == "Cc" for ch in value):
            return f"The {name} has a control character (for example a NUL byte) that cannot be saved or sent to an agent — remove it and try again."
    return None


def normalize_persona_text(value: str | None) -> str | None:
    """Saved = run: what the session will get, written at the write. Line endings and U+2028/2029 become plain newlines (the same line break the person saw), invisible format characters
    (bidi marks and overrides, zero-width, soft hyphen, BOM, tag characters — `Cf`) are dropped. Nothing visible changes for the person; the text in the editor IS the text of the session."""
    if value is None:
        return None
    text = value.replace("\r\n", "\n").replace("\r", "\n").replace("\u2028", "\n").replace("\u2029", "\n")
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cf")


async def base_children_problem(
    db: AsyncSession, *, org_id: uuid.UUID, base_id: uuid.UUID, children: list[tuple[uuid.UUID, str, str | None, str | None]], new_system: str | None, new_style: str | None,
) -> str | None:
    """A base persona is joined into every persona that names it: when the base is PATCHed longer, each of those would be re-judged on what it would leave (the daemon would otherwise cut
    it silently). A readable sentence naming up to three of them with their numbers, or None."""
    found: list[str] = []
    for _cid, name, system_prompt, style_prompt in children:
        problem = await persona_write_problem(
            db, org_id=org_id, system_prompt=system_prompt, style_prompt=style_prompt, base_persona_id=base_id, base_override=(new_system, new_style),
        )
        if problem:
            found.append(f"\"{name}\" (it uses this persona as its base): {problem}")
        if len(found) == 3:
            break
    return " | ".join(found) if found else None


async def persona_write_problem(
    db: AsyncSession, *, org_id: uuid.UUID, system_prompt: str | None, style_prompt: str | None, base_persona_id: uuid.UUID | str | None = None,
    base_override: tuple[str | None, str | None] | None = None,
) -> str | None:
    """story 4680 AC2 (PO 2026-10-18) — the same caps the daemon is handed, checked where the text is WRITTEN: a persona's instructions (its own, plus its base persona's when one is
    named) are at most PERSONA_TEXT_MAX characters and PERSONA_TEXT_MAX_BYTES bytes, its style (base's + own) PERSONA_STYLE_MAX characters and PERSONA_STYLE_MAX_BYTES bytes. Over → a readable
    sentence (how many, how many at most); the route answers 422 and writes nothing — so a text the person wrote is never silently cut on its way into a session. The values are the EFFECTIVE
    ones (a PATCH that changes one field is judged with the others it keeps), counted after the same filter the daemon's read applies."""
    base = None
    if base_persona_id:
        try:
            bid = base_persona_id if isinstance(base_persona_id, uuid.UUID) else uuid.UUID(str(base_persona_id))
        except ValueError:
            bid = None
        if bid is not None:
            base = (await db.execute(select(AgentPersona).where(AgentPersona.id == bid, AgentPersona.org_id == org_id, AgentPersona.deleted_at.is_(None)))).scalar_one_or_none()
    # `base_override`: the base's texts as they are ABOUT to be (its own PATCH) — the stored ones are the old ones
    base_system, base_style = (base_override if base_override is not None else (base.system_prompt, base.style_prompt) if base is not None else (None, None))
    own = _clean_persona_text(system_prompt, 10**9, 10**9)
    base_text = _clean_persona_text(base_system, 10**9, 10**9) if base is not None else ""
    total = "\n\n".join(p for p in (base_text, own) if p)
    chars, size = len(total), len(total.encode("utf-8"))
    if chars > PERSONA_TEXT_MAX or size > PERSONA_TEXT_MAX_BYTES:
        return (
            f"The instructions are too long: {chars:,} characters ({size:,} bytes{' with its base persona' if base_text else ''}); the most a role's instructions may take is "
            f"{PERSONA_TEXT_MAX:,} characters and {PERSONA_TEXT_MAX_BYTES:,} bytes — shorten them by {max(chars - PERSONA_TEXT_MAX, (size - PERSONA_TEXT_MAX_BYTES + 3) // 4):,} characters or more."
        )
    style_parts = [_clean_persona_text(base_style if base is not None else None, 10**9, 10**9), _clean_persona_text(style_prompt, 10**9, 10**9)]
    st = "\n\n".join(p for p in style_parts if p)
    st_bytes = len(st.encode("utf-8"))
    if len(st) > PERSONA_STYLE_MAX or st_bytes > PERSONA_STYLE_MAX_BYTES:
        return (
            f"The style is too long: {len(st):,} characters ({st_bytes:,} bytes{' with its base persona' if style_parts[0] else ''}); the most it may take is {PERSONA_STYLE_MAX:,} characters and "
            f"{PERSONA_STYLE_MAX_BYTES:,} bytes — shorten it by {max(len(st) - PERSONA_STYLE_MAX, (st_bytes - PERSONA_STYLE_MAX_BYTES + 3) // 4):,} characters or more."
        )
    return None


async def persona_for_daemon(db: AsyncSession, *, member: Member, project_id: uuid.UUID | None = None) -> dict | None:
    """story 4680 AC2 — the role the agent was hired for, handed to the daemon so a session starts AS that role (a CLI started in a folder knows only its own files).

    Only THIS agent's own default persona (`agent_personas.is_default` — the recruit's, or the one the org set; never a built-in) in its own organization: the agent
    key reads its own row and nothing else. `project_id` (the project the start is for — required, and the agent must be in it) picks that project's persona; without it, or when that project has none (or the
    agent is not in it), there is no role (None). `role` is the persona's name (the recruit writes the job template's name there — `members.agent_role` stays empty
    for a recruited agent), `instructions` the text (base persona's + own), `style` likewise. Every piece goes through the same filter and the total stays inside one cap
    (characters and bytes). `version` is a digest of what is handed — the daemon logs it (never the text) so «which version was in the session» can be answered.
    No default persona → None (the field is left out: an agent that was never hired as a role starts as it did)."""
    if getattr(member, "org_id", None) is None:
        return None
    # the project the START is for, and only that one: no project, a project this agent is not in, or one with no default persona → no role at all (never another project's —
    # a silent substitution would start the agent as a role it was not hired for there)
    if project_id is None:
        return None
    from app.models.team import TeamMember

    in_project = (await db.execute(
        select(TeamMember.id).where(TeamMember.id == member.id, TeamMember.org_id == member.org_id, TeamMember.project_id == project_id).limit(1)
    )).scalar_one_or_none()
    if in_project is None:
        return None
    row = (await db.execute(
        select(AgentPersona).where(
            AgentPersona.org_id == member.org_id, AgentPersona.agent_id == member.id, AgentPersona.project_id == project_id,
            AgentPersona.deleted_at.is_(None), AgentPersona.is_builtin.is_(False), AgentPersona.is_default.is_(True),
        ).order_by(AgentPersona.created_at.asc(), AgentPersona.id).limit(1)
    )).scalar_one_or_none()
    if row is None:
        return None
    from app.models.role_template import RoleTemplate
    from app.repositories.agent_persona import AgentPersonaRepository
    from app.services import agent_recruiter

    base = await AgentPersonaRepository(db)._get_base(row.config or {}, row.org_id)
    # a base persona is joined only when it is a built-in or belongs to this same agent in this same project — the lookup itself knows only the organization, and another
    # agent's or project's text must not ride into this agent's session
    if base is not None and (base.id == row.id or not (base.is_builtin or (base.agent_id == row.agent_id and base.project_id == row.project_id))):
        base = None   # (a persona that names ITSELF as its base would be joined twice)
    own = (row.system_prompt or "")
    # a recruited persona carries its job template's id: the session edition is composed from that (role + operating rules + workflow pointer — not the tool table,
    # not the one-time integration prompt). Without a template (hand-written, or the template is gone) the persona's own text, minus the integration prompt if it has one.
    own_text: str | None = None
    template_id = (row.config or {}).get("role_template_id")
    if template_id:
        try:
            template = await db.get(RoleTemplate, uuid.UUID(str(template_id)))
        except ValueError:
            template = None
        if template is not None:
            own_text = agent_recruiter.compose_session_kit(template, agent_recruiter.kit_locale_of(own))
    if own_text is None:
        own_text = agent_recruiter.strip_integration_prompt(own)
    # the base persona goes through the same filter, and base + own stay inside the one cap
    instructions = _clean_persona_text("\n\n".join(p for p in (_clean_persona_text(base.system_prompt if base else None, PERSONA_TEXT_MAX), _clean_persona_text(own_text, PERSONA_TEXT_MAX)) if p), PERSONA_TEXT_MAX)
    style = _clean_persona_text("\n\n".join(p for p in (_clean_persona_text(base.style_prompt if base else None, PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES), _clean_persona_text(row.style_prompt, PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES)) if p), PERSONA_STYLE_MAX, PERSONA_STYLE_MAX_BYTES) or None
    role = _one_line(row.name, PERSONA_ROLE_MAX) or _one_line(getattr(member, "agent_role", None), PERSONA_ROLE_MAX)
    if not instructions and not role:
        return None
    digest = hashlib.sha256("\x00".join([role, instructions, style or ""]).encode("utf-8")).hexdigest()[:16]
    return {"role": role or None, "instructions": instructions, "style": style, "version": digest}


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
        # story #4598 → #4708: on → the daemon starts the next session in the CLI's bypassPermissions mode — tools run right away, and
        # what the agent may and may not do follows the person's own Claude Code settings on that computer (contract v0.1 §2)
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

    story #4598: `unattended` (a bool, or KEEP) — a change of it is an org owner's only (`actor_is_owner` = `member_resolver.is_active_owner`):
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
