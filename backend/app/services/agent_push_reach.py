"""story #4761 (D3): which agents a new message can REACH by itself, and which only see it when someone makes them look.

An agent is reached by push when the message goes to it by webhook, or when it holds a live gateway stream (`/agent/stream` —
the channel plugin and the desktop app's daemon). An agent on the bare hosted MCP (`.mcp.json`, http) has neither: it reads
Sprintable only while it is calling a tool, so nothing wakes it — it answers when a person tells it to look. Showing such an
agent as «typing» (what `chat_presence.set_working` does) was a lie that lasted its whole TTL, and the sender was left
waiting with nothing said (4759 walk: first instruction 23:30:16Z, no reply for 107 s, «입력 중» the whole time).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession


async def push_reachable_agent_ids(
    db: AsyncSession, agent_ids: set[uuid.UUID], *, webhook_covered: set[uuid.UUID],
) -> set[uuid.UUID]:
    """The subset of `agent_ids` a message reaches without anyone prompting them.

    A live gateway stream is judged the way the connection test judges it (`agent_verify._has_fresh_session`): when presence runs
    on Redis the session row's `last_seen_at` is not kept fresh, so «online» is read from Redis (and the row's existence when Redis
    is down) — a quiet row is not a dead stream. One check per agent that is neither webhook-covered nor already known."""
    from app.services.agent_verify import _has_fresh_session

    reached = {a for a in agent_ids if a in webhook_covered}
    for agent in sorted(agent_ids - reached):  # a message has a handful of agent recipients — one read each is fine
        if await _has_fresh_session(db, agent):
            reached.add(agent)
    return reached
