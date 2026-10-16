"""story 4717 (AC4 · PO 10-16 04:04Z) — the one count of an organization's agents that the plan's agent limit is about.

Every place that compares agents with the plan limit calls this and nothing else: the limit check (`ee/plan_limits.check_agent_add_limit`),
the desktop setup's «agents before this setup» (`services/desktop_setup.py`) and the setup page's read of how many more it can make
(`GET /desktop/recipes`). One query means the number the page shows before [시작] and the number in a 402 cannot disagree.

What is counted: active, not deleted agent members of the organization — except the organization's «시스템 발행»
(`runtime_type == 'system-publisher'`, `routers/events.py::_get_or_create_system_publisher`). The server makes that member the
first time a preset event is published (a story's status or assignee changing, a gate verdict…); no customer made it and no
customer can use it, so it never takes one of the customer's places (the free plan's 3 were 2 in practice — 4717 AC0).
An agent with no runtime type yet is a customer's agent and is counted.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.system_publisher_guard import SYSTEM_PUBLISHER_RUNTIME_TYPE

_COUNT_SQL = text(
    "SELECT COUNT(*) FROM members "
    "WHERE org_id = :oid AND type = 'agent' AND is_active = true AND deleted_at IS NULL "
    "AND (runtime_type IS NULL OR runtime_type <> :reserved)"
)


async def plan_agent_count(db: AsyncSession, org_id: uuid.UUID | str) -> int:
    """The organization's agents as the plan's agent limit counts them (see the module note)."""
    return int((await db.execute(_COUNT_SQL, {"oid": str(org_id), "reserved": SYSTEM_PUBLISHER_RUNTIME_TYPE})).scalar() or 0)
