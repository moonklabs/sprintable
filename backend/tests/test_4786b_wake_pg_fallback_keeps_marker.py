"""story 4786 part B — with the Redis fan-out off (the dev realtime stack off) a wake sent by one backend instance must still make the agent's stream on ANOTHER instance rescan.

The fallback sends the wake through Postgres NOTIFY; the receiving instance's listener ignores the event type and queues only `data`, so the `__wake__` marker has to be in `data`. It was only in the event type
(`{"seq": seq}`): the other instance saw a plain event, the stream loop never ran its catch-up rescan, and the desktop stream missed the event until it reconnected (found by the codex read of PR-B).
"""
from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import MagicMock, patch

import pytest

from app.core.config import settings as _cfg_settings


def _wake_over_postgres(agent_id: str, seq: int) -> dict:
    """call wake_agent with the fan-out flag OFF and return the `data` it handed to pg_notify"""
    from app.routers import agent_gateway

    notify = MagicMock(return_value="coroutine-placeholder")
    with patch.object(_cfg_settings, "fanout_wake_redis_enabled", False), \
         patch("app.services.pg_pubsub.pg_notify", new=notify), \
         patch("app.services.pg_pubsub.fire_and_forget", new=MagicMock()):
        agent_gateway.wake_agent(agent_id, seq)
    notify.assert_called_once()
    target, target_id, event_type, data = notify.call_args.args
    assert (target, target_id, event_type) == ("agent", agent_id, "__wake__")
    return data


def test_the_postgres_fallback_carries_the_wake_marker_in_data():
    data = _wake_over_postgres(str(uuid.uuid4()), 5)
    assert data == {"__wake__": True, "seq": 5}  # reverted (the marker only in the event type) → {"seq": 5}


@pytest.mark.anyio
async def test_the_other_instance_queues_a_wake_signal_for_the_stream_loop():
    """what the receiving instance does with that notification: the signal the stream loop reads has the marker (the loop then rescans)"""
    from app.routers import events as events_mod
    from app.services import pg_pubsub

    agent_id = str(uuid.uuid4())
    data = _wake_over_postgres(agent_id, 9)
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    events_mod._agent_connections[agent_id].add(q)
    try:
        envelope = json.dumps({"instance_id": "OTHER_NODE", "target": "agent", "target_id": agent_id, "event_type": "__wake__", "data": data})
        await pg_pubsub._dispatch_received(envelope)
        signal = q.get_nowait()
        assert signal.get("__wake__") is True and signal.get("seq") == 9
    finally:
        events_mod._agent_connections[agent_id].discard(q)
        events_mod._agent_connections.pop(agent_id, None)
