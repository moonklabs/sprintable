"""story 5041 ② — what an agent may do on its own, set by the USER: «always allow» (auto) · «ask first» (ask) · «block» (block), per action × agent × project.

The product decides only the DEFAULTS (the survey table, PO 11-27); everything beyond is the user's setting (PO: «the product does not decide what a user's agent may do»).

Where it is kept: `hitl_gate_config` (0123 · widened by 0507) — `work_type = 'action:<key>'`, `actor_type = 'agent'`, an optional `agent_id`, an optional `project_id`. Resolution, the narrow one wins:
    project + agent  →  project  →  organisation + agent  →  organisation  →  the default of the action  (a «floor» action is always `block`, whatever is stored)

Guard rails (PO 11-27, seq 20579):
  · `auto` is given only to ONE agent in ONE project (no organisation-wide auto) — a stored `auto` that lacks either scope is not honoured (it reads as `ask`);
  · the organisation / project themselves have no `auto` slot: they are always a card (`NO_AUTO`) — the person presses each time; nothing is forbidden;
  · the 19 «floor» rows (a person's own signature · approval · consent: gate approval · HITL · phone-signed commands · device keys · remote control · document confirm · hypothesis verdict · setup confirm) cannot be set at all.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hitl import HitlGateConfig

LEVELS: tuple[str, ...] = ("auto", "ask", "block")
WORK_TYPE_PREFIX = "action:"

# the 19 «그대로 막음» rows of the survey table (doc c1377f7e §2-가): the person's own signature / approval / consent is the purpose of the rule — never settable
FLOOR_ACTIONS: dict[str, int] = {
    "agent_permission.answer": 13,
    "channel_draft_media.foreign_participant": 37,
    "room.access_revoked_agent": 42,
    "room.participant_add_unreadable": 43,
    "desktop_command.person_session": 44,
    "desktop.startable_read": 45,
    "desktop_relay.phone_person": 46,
    "desktop_setup.confirm": 47,
    "desktop_setup.confirm_solo": 48,
    "desktop_setup.confirm_new_org": 49,
    "desktop_setup.confirm_new_org_solo": 50,
    "device_token.confirm": 61,
    "gate.approve": 67,
    "hitl.decide": 69,
    "remote_control.set": 83,
    "desktop_commands.create": 95,
    "desktop_commands.start": 96,
    "doc.confirm": 97,
    "hypothesis.decide": 102,
}

# no `auto` slot — the organisation and the project themselves are always a card
NO_AUTO: frozenset[str] = frozenset({"org.delete", "project.delete"})

DEFAULT_LEVEL = "ask"


class PolicyError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail or code


def adjustable_actions() -> tuple[str, ...]:
    """the actions a person can set — those the approval card knows (`agent_action.SPECS`) plus the ones with no auto slot"""
    from app.services.agent_action import SPECS

    return tuple(sorted((set(SPECS) | NO_AUTO) - set(FLOOR_ACTIONS)))  # a floor row is never «adjustable» (it is listed separately, locked)


def default_level(action_key: str) -> str:
    if action_key in FLOOR_ACTIONS:
        return "block"
    return DEFAULT_LEVEL


def _work_type(action_key: str) -> str:
    return f"{WORK_TYPE_PREFIX}{action_key}"


def _honoured(level: str, *, action_key: str, project_id: uuid.UUID | None, agent_id: uuid.UUID | None) -> str:
    """a stored value is never WIDER than the rules allow: an `auto` that lacks the agent or the project, or on an action with no auto slot, reads as `ask`"""
    if level == "auto" and (project_id is None or agent_id is None or action_key in NO_AUTO):
        return "ask"
    return level


async def resolve_action_level(
    session: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID | None, agent_id: uuid.UUID | None, action_key: str,
) -> tuple[str, str]:
    """(level, source) — source: `floor` · `project_agent` · `project` · `org_agent` · `org` · `default`"""
    if action_key in FLOOR_ACTIONS:
        return "block", "floor"
    rows = (await session.execute(
        select(HitlGateConfig.project_id, HitlGateConfig.agent_id, HitlGateConfig.level).where(
            HitlGateConfig.org_id == org_id,
            HitlGateConfig.work_type == _work_type(action_key),
            HitlGateConfig.actor_type == "agent",
        )
    )).all()
    by_scope = {(r[0], r[1]): r[2] for r in rows}
    order = (
        ("project_agent", (project_id, agent_id) if project_id is not None and agent_id is not None else None),
        ("project", (project_id, None) if project_id is not None else None),
        ("org_agent", (None, agent_id) if agent_id is not None else None),
        ("org", (None, None)),
    )
    for source, scope in order:
        if scope is not None and scope in by_scope:
            return _honoured(by_scope[scope], action_key=action_key, project_id=scope[0], agent_id=scope[1]), source
    return default_level(action_key), "default"


async def set_action_level(
    session: AsyncSession, *, org_id: uuid.UUID, action_key: str, level: str, project_id: uuid.UUID | None, agent_id: uuid.UUID | None, set_by: uuid.UUID,
) -> HitlGateConfig:
    """one setting (upsert). The caller has checked WHO may set it (an owner / admin, a person's session)."""
    if action_key in FLOOR_ACTIONS:
        raise PolicyError("ACTION_POLICY_FLOOR", "this is a person's own signature or approval — it cannot be set")
    if action_key not in adjustable_actions():
        raise PolicyError("ACTION_POLICY_UNKNOWN_ACTION")
    if level not in LEVELS:
        raise PolicyError("ACTION_POLICY_LEVEL_INVALID")
    if level == "auto":
        if action_key in NO_AUTO:
            raise PolicyError("ACTION_POLICY_NO_AUTO_SLOT", "this one is always a card")
        if project_id is None or agent_id is None:
            raise PolicyError("ACTION_POLICY_AUTO_NEEDS_PROJECT_AND_AGENT", "«always allow» is for one agent in one project")
    values = dict(org_id=org_id, project_id=project_id, agent_id=agent_id, work_type=_work_type(action_key), actor_type="agent", level=level, created_by=set_by)
    stmt = pg_insert(HitlGateConfig.__table__).values(**values)
    # the four unique indexes of 0507 — one per scope
    if project_id is None and agent_id is None:
        stmt = stmt.on_conflict_do_update(index_elements=["org_id", "work_type", "actor_type"], index_where=text("project_id IS NULL AND agent_id IS NULL"), set_={"level": level, "updated_at": func.now()})
    elif project_id is not None and agent_id is None:
        stmt = stmt.on_conflict_do_update(index_elements=["org_id", "project_id", "work_type", "actor_type"], index_where=text("project_id IS NOT NULL AND agent_id IS NULL"), set_={"level": level, "updated_at": func.now()})
    elif project_id is None:
        stmt = stmt.on_conflict_do_update(index_elements=["org_id", "agent_id", "work_type", "actor_type"], index_where=text("project_id IS NULL AND agent_id IS NOT NULL"), set_={"level": level, "updated_at": func.now()})
    else:
        stmt = stmt.on_conflict_do_update(index_elements=["org_id", "project_id", "agent_id", "work_type", "actor_type"], index_where=text("project_id IS NOT NULL AND agent_id IS NOT NULL"), set_={"level": level, "updated_at": func.now()})
    await session.execute(stmt)
    await session.flush()
    return (await session.execute(_scope_select(org_id, action_key, project_id, agent_id))).scalars().one()


def _scope_select(org_id: uuid.UUID, action_key: str, project_id: uuid.UUID | None, agent_id: uuid.UUID | None):
    return select(HitlGateConfig).where(
        HitlGateConfig.org_id == org_id,
        HitlGateConfig.work_type == _work_type(action_key),
        HitlGateConfig.actor_type == "agent",
        HitlGateConfig.project_id.is_(None) if project_id is None else HitlGateConfig.project_id == project_id,
        HitlGateConfig.agent_id.is_(None) if agent_id is None else HitlGateConfig.agent_id == agent_id,
    ).execution_options(populate_existing=True)


async def clear_action_level(
    session: AsyncSession, *, org_id: uuid.UUID, action_key: str, project_id: uuid.UUID | None, agent_id: uuid.UUID | None,
) -> bool:
    """back to what the wider scope (or the default) says; True if a row was removed"""
    if action_key in FLOOR_ACTIONS:
        raise PolicyError("ACTION_POLICY_FLOOR")
    res = await session.execute(delete(HitlGateConfig).where(
        HitlGateConfig.org_id == org_id,
        HitlGateConfig.work_type == _work_type(action_key),
        HitlGateConfig.actor_type == "agent",
        HitlGateConfig.project_id.is_(None) if project_id is None else HitlGateConfig.project_id == project_id,
        HitlGateConfig.agent_id.is_(None) if agent_id is None else HitlGateConfig.agent_id == agent_id,
    ))
    await session.flush()
    return (res.rowcount or 0) > 0


@dataclass(frozen=True)
class EffectiveAction:
    action_key: str
    level: str
    source: str
    locked: bool          # a floor row: shown, cannot be changed
    auto_allowed: bool    # whether this action has an `auto` slot at all


async def list_effective(session: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID | None, agent_id: uuid.UUID | None) -> list[EffectiveAction]:
    out: list[EffectiveAction] = []
    for key in adjustable_actions():
        level, source = await resolve_action_level(session, org_id=org_id, project_id=project_id, agent_id=agent_id, action_key=key)
        out.append(EffectiveAction(key, level, source, locked=False, auto_allowed=key not in NO_AUTO))
    for key in sorted(FLOOR_ACTIONS, key=FLOOR_ACTIONS.get):
        out.append(EffectiveAction(key, "block", "floor", locked=True, auto_allowed=False))
    return out
