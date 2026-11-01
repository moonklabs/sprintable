"""story #4761 (D3): which agents a new message can REACH by itself, and which only see it when someone makes them look.

An agent is reached by push when the message goes to it by webhook, or when it holds a live gateway stream (`/agent/stream` —
the channel plugin and the desktop app's daemon). An agent on the bare hosted MCP (`.mcp.json`, http) has neither: it reads
Sprintable only while it is calling a tool, so nothing wakes it — it answers when a person tells it to look. Showing such an
agent as «typing» (what `chat_presence.set_working` does) was a lie that lasted its whole TTL, and the sender was left
waiting with nothing said (4759 walk: first instruction 23:30:16Z, no reply for 107 s, «입력 중» the whole time).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_gateway import AgentGatewaySession


async def _agents_with_live_stream(db: AsyncSession, agent_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """The agents of `agent_ids` that hold a live gateway stream — judged as `agent_verify._has_fresh_session` judges one agent
    (that is the connection test's rule), in one pass for all of them:

    - presence on Redis (`presence_online_redis_enabled`): the session row's `last_seen_at` is not kept fresh then, so «online» is
      read from Redis — all agents at once; the ones Redis cannot answer for (it is down: None) fall back to «has a session row»
    - otherwise: a session row seen within the session window — one query.
    """
    from app.core.config import settings

    if settings.presence_online_redis_enabled and settings.redis_url:
        from app.services import presence_online

        answers = await asyncio.gather(*(presence_online.is_online(a) for a in agent_ids))
        live = {a for a, online in zip(agent_ids, answers) if online}
        unknown = [a for a, online in zip(agent_ids, answers) if online is None]
        if unknown:
            rows = (await db.execute(
                select(AgentGatewaySession.agent_id).where(AgentGatewaySession.agent_id.in_(unknown)).distinct()
            )).scalars().all()
            live |= set(rows)
        return live

    from app.routers.agent_gateway import _SESSION_FRESH_TTL  # lazy: the router imports this layer's neighbours

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=_SESSION_FRESH_TTL)
    rows = (await db.execute(
        select(AgentGatewaySession.agent_id).where(
            AgentGatewaySession.agent_id.in_(agent_ids),
            AgentGatewaySession.last_seen_at >= cutoff,
        ).distinct()
    )).scalars().all()
    return set(rows)


async def push_reachable_agent_ids(
    db: AsyncSession, agent_ids: set[uuid.UUID], *, webhook_covered: set[uuid.UUID],
) -> set[uuid.UUID]:
    """The subset of `agent_ids` a message reaches without anyone prompting them. No read at all when nothing is left to ask
    after the webhook-covered ones."""
    reached = {a for a in agent_ids if a in webhook_covered}
    to_ask = sorted(agent_ids - reached)
    if not to_ask:
        return reached
    return reached | await _agents_with_live_stream(db, to_ask)
