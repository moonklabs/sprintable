"""story #4565 (Qadir lens ① · PO 02:31Z) — one recheck for every long-lived connection an agent key opens.

A key is checked when a connection opens. A key revoked afterwards — a desktop setup disconnected (#4434), or an existing agent
moved to another computer by a setup exchange (#4565: its old keys are revoked in that exchange) — must also end connections
that are already open, or the old launcher keeps talking and listening as that agent. `/agent/stream` had this since #4434;
this module is that same check for `/events/stream`, the A2A streaming reply and the `/ws/chat` socket.

None = still allowed; otherwise the reason (`key_revoked` · `agent_inactive` / `member_inactive`). Fails closed on a key id that is not a UUID
(a future auth path that carries no id must not slip through quietly). A DB error or timeout skips one check (a log line) —
the recheck must not become a new way to drop connections while the DB is unwell; any other error propagates."""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import async_session_factory

logger = logging.getLogger(__name__)

# how old the last check may be before a connection hands out more content (the same 5 s as /agent/stream's batches)
RECHECK_BEFORE_SEND_SEC: float = 5.0


async def key_access_revoked_db(key_uuid: uuid.UUID, member_id: uuid.UUID | None, *, agent_only: bool = True) -> str | None:
    """`member_id` None: the key alone (a caller whose member is not at hand — the key's own revocation is what moves)."""
    from app.models.api_key import ApiKey
    from app.models.team import TeamMember

    async with async_session_factory() as db:
        key = (await db.execute(select(ApiKey.revoked_at, ApiKey.expires_at).where(ApiKey.id == key_uuid))).first()
        if key is None or key.revoked_at is not None or (key.expires_at is not None and key.expires_at <= datetime.now(timezone.utc)):
            return "key_revoked"
        if member_id is None:
            return None
        q = select(TeamMember.id).where(TeamMember.id == member_id, TeamMember.is_active.is_(True))
        if agent_only:
            q = q.where(TeamMember.type == "agent")
        if (await db.execute(q.limit(1))).scalar_one_or_none() is None:
            return "agent_inactive" if agent_only else "member_inactive"
    return None


async def key_access_revoked(api_key_id: object, member_id: uuid.UUID | None, *, agent_only: bool = True, db_check=None) -> str | None:
    try:
        key_uuid = uuid.UUID(str(api_key_id))
    except (TypeError, ValueError):
        return "key_revoked"
    try:
        return await (db_check or key_access_revoked_db)(key_uuid, member_id, agent_only=agent_only)
    except (SQLAlchemyError, TimeoutError):
        logger.warning("stream access recheck failed member_id=%s — skipped this time", member_id, exc_info=True)
        return None


class AccessRecheck:
    """The recheck of one connection: `due(age)` checks when the last check is at least `age` seconds old (None = allowed
    or not due). The connect check counts as the first one."""

    def __init__(self, api_key_id: object, member_id: uuid.UUID | None, *, agent_only: bool = True) -> None:
        self.api_key_id = api_key_id
        self.member_id = member_id
        self.agent_only = agent_only
        self.last = time.monotonic()

    async def due(self, age: float) -> str | None:
        if time.monotonic() - self.last < age:
            return None
        self.last = time.monotonic()
        return await key_access_revoked(self.api_key_id, self.member_id, agent_only=self.agent_only)
