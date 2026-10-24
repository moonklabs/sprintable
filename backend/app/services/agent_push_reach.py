"""story #4761 (D3): which agents a new message can REACH by itself, and which only see it when someone makes them look.

An agent is reached by push when the message goes to it by webhook, or when it holds a live gateway stream (`/agent/stream` —
the channel plugin and the desktop app's daemon). An agent on the bare hosted MCP (`.mcp.json`, http) has neither: it reads
Sprintable only while it is calling a tool, so nothing wakes it — it answers when a person tells it to look. Showing such an
agent as «typing» (what `chat_presence.set_working` does) was a lie that lasted its whole TTL, and the sender was left
waiting with nothing said (4759 walk: first instruction 23:30:16Z, no reply for 107 s, «입력 중» the whole time).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_gateway import AgentGatewaySession


async def push_reachable_agent_ids(
    db: AsyncSession, agent_ids: set[uuid.UUID], *, webhook_covered: set[uuid.UUID],
) -> set[uuid.UUID]:
    """The subset of `agent_ids` a message reaches without anyone prompting them. One query, none when nothing is left to ask."""
    reached = {a for a in agent_ids if a in webhook_covered}
    to_ask = agent_ids - reached
    if not to_ask:
        return reached
    from app.routers.agent_gateway import _SESSION_FRESH_TTL  # lazy: the router imports this layer's neighbours

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_SESSION_FRESH_TTL)
    rows = (await db.execute(
        select(AgentGatewaySession.agent_id).where(
            AgentGatewaySession.agent_id.in_(to_ask),
            AgentGatewaySession.last_seen_at >= cutoff,
        ).distinct()
    )).scalars().all()
    return reached | set(rows)
