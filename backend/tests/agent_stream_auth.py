"""story #4434 (PO 14:15Z) — the one helper the agent-stream tests use for their key.

The stream now rechecks its key on every heartbeat tick and fails closed: a missing, malformed or unknown key id ends the
stream («key_revoked»). Real agent keys always carry a UUID `api_key_id` (dependencies/auth.py), so tests do too:
- a realdb test seeds a real key row for its agent (`seed_agent_stream_key`) and puts that id in its claims;
- a test whose DB is mocked just carries a UUID (there is no row to seed; its mock answers the lookups).
"""
from __future__ import annotations

import uuid


def agent_stream_claims(key_id: uuid.UUID | str, org_id: uuid.UUID | str | None = None) -> dict:
    """The claims an agent key authenticates with: its key id (a UUID, as real keys carry) and, if given, the org."""
    meta: dict = {"api_key_id": str(key_id)}
    if org_id is not None:
        meta["org_id"] = str(org_id)
    return {"app_metadata": meta}


async def seed_agent_stream_key(session, agent_id: uuid.UUID) -> uuid.UUID:
    """A live key row for this agent (not revoked · no expiry), committed; returns its id."""
    from app.models.api_key import ApiKey

    key = ApiKey(
        id=uuid.uuid4(), team_member_id=agent_id, key_prefix="sk_test_stream", key_hash=uuid.uuid4().hex,
    )
    session.add(key)
    await session.commit()
    return key.id
