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


async def host_run_agent_ids(db: AsyncSession, agent_ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """story 5046 (C13): the agents of `agent_ids` a HOST runs — every stream row the agent holds says `host` (the client's own word when it opened `/agent/stream`) and it holds at least one.

    A webhook agent (no stream row), the channel plugin and an old host (the row says nothing) are NOT host-run — and an agent with both a host row and another kind is not either (a message can go to
    either of them, and only the host reads `delivery_mode`). Rows are the liveness: a row goes with its connection (`agent_gateway` deletes it on disconnect and sweeps the dead ones).

    ⚠ The word is the client's own, not a login. This is read ONLY to say what the web should DRAW (the «지금 끼어들기 / 끝나고 이어서» choice) — never a permission, a key, a room's read or a delivery road
    (the reach decision above does not read it; a census test keeps it that way).
    """
    if not agent_ids:
        return set()
    from sqlalchemy import func

    from app.core.config import settings

    # LIVE first, by the very rule `set_working` used (a row that only waits to expire after a lifespan end — `_mark_agent_disconnected` stamps it instead of deleting — is not a live stream: a host that is gone and a webhook that
    # marks the agent working must not read as «a host runs it»)
    live = await _agents_with_live_stream(db, sorted(agent_ids))
    if not live:
        return set()
    stmt = (
        select(
            AgentGatewaySession.agent_id,
            # NULL (no word) counts as «not host»: bool_and skips NULLs, so a host row beside a NULL row would read as all-host without the coalesce
            func.bool_and(func.coalesce(AgentGatewaySession.client_kind == "host", False)),
        )
        .where(AgentGatewaySession.agent_id.in_(sorted(live)))
        .group_by(AgentGatewaySession.agent_id)
    )
    if not (settings.presence_online_redis_enabled and settings.redis_url):
        # the rows' own freshness is the liveness there (with Redis presence `last_seen_at` is not kept fresh — liveness came from Redis above); a stale row of an earlier connection is not counted either way
        from app.routers.agent_gateway import _SESSION_FRESH_TTL  # lazy: the router imports this layer's neighbours

        stmt = stmt.where(AgentGatewaySession.last_seen_at >= datetime.now(timezone.utc) - timedelta(seconds=_SESSION_FRESH_TTL))
    return {a for a, all_host in (await db.execute(stmt)).all() if all_host is True}

