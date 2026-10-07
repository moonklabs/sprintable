"""story #4582 (E-DESKTOP-2 · 4543 crew move) — at most one connection test waits for an agent.

Measured (dev, 10-07 07:3xZ · counts only): Damrong had 6,389 `onboarding.connection_test` rows, one per stream reconnect (~5 min)
since 09-12 — the stream started a fresh test on every connect while the agent was not verified, and a receiver that drops this kind
without an ack (the launcher plugin) never moved its cursor past it. Dan 2,721 · Min 75 in a day until other traffic moved his cursor.
Now a connect starts a test only when none is waiting: two connects with no ack → one test row; after the ack (verified) a connect adds
none. Real setup + key + stream over a migrated PG (the 4424 harness); start_verification · get_verification_state run for real.
"""
from __future__ import annotations

import pytest

from tests.test_4424_desktop_setup_realdb import (  # noqa: F401 — fixtures (autouse ones apply here too)
    _ASYNC,
    ORG,
    _addresses,
    _client,
    _dispose_global_engine_after_test,
    _open_setup_stream,
    _sql,
    _StreamRequest,
    anyio_backend,
    world,
)

pytestmark = pytest.mark.anyio


def _quiet_but_verify(monkeypatch):
    """the 4424 quiet set, less the two this test is about (start_verification · get_verification_state stay real)"""
    from unittest.mock import AsyncMock

    for target in (
        "app.services.agent_anchor_sync.sync_agent_profile_presence", "app.services.onboarding_funnel.emit_onboarding_event",
        "app.services.agent_verify.push_verification_signal", "app.services.presence_online.mark_online",
        "app.services.presence_events.emit_presence", "app.services.sse_lease.refresh", "app.services.sse_lease.release",
    ):
        monkeypatch.setattr(target, AsyncMock())
    monkeypatch.setattr("app.services.sse_lease.acquire", AsyncMock(return_value=None))


async def _tests_for(agent_id: str) -> list[int]:
    rows = await _sql(fetch=(
        f"SELECT recipient_seq FROM events WHERE recipient_id='{agent_id}' AND event_type='onboarding.connection_test' ORDER BY recipient_seq"
    ))
    return [r[0] for r in rows]


async def _connect_once(agent_id: str, auth) -> None:
    """one stream connect: the connect step runs before the first heartbeat is yielded; then the stream is closed"""
    import app.routers.agent_gateway as ag
    from app.core import shutdown as shutdown_module

    agen = (await ag.agent_stream(_StreamRequest(), auth=auth)).body_iterator
    try:
        assert "event: heartbeat" in await agen.__anext__()
    finally:
        await agen.aclose()
        ag._agent_connections.clear()
        shutdown_module.reset_shutdown_event()


async def test_a_reconnect_adds_no_test_while_one_waits_and_none_once_verified(world, monkeypatch):
    import app.routers.agent_gateway as ag
    from app.dependencies.auth import AuthContext
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    _quiet_but_verify(monkeypatch)
    monkeypatch.setattr(ag, "_SSE_HEARTBEAT", 30.0)
    async with _client() as c:
        _setup_id, agent_id, agen = await _open_setup_stream(c, "d4582 one test")
        try:
            assert "event: heartbeat" in await agen.__anext__()  # the first connect: a never-verified agent gets its test
        finally:
            await agen.aclose()
            ag._agent_connections.clear()
        first = await _tests_for(agent_id)
        assert len(first) == 1, f"the first connect starts one test: {first}"

        key_id = (await _sql(fetch=f"SELECT id FROM agent_api_keys WHERE team_member_id='{agent_id}' AND revoked_at IS NULL"))[0][0]
        auth = AuthContext(user_id=agent_id, email=None, claims={"app_metadata": {"api_key_id": str(key_id), "org_id": str(ORG)}})
        # two reconnects with no ack (a receiver that drops this kind) — before #4582 each added one (3 rows here)
        await _connect_once(agent_id, auth)
        await _connect_once(agent_id, auth)
        assert await _tests_for(agent_id) == first, "a test is waiting: a reconnect adds none"

        # the ack past it (the product's own ack path) → verified → a reconnect adds none either (unchanged)
        eng = create_async_engine(_ASYNC, poolclass=NullPool)
        try:
            async with async_sessionmaker(eng)() as s:
                await ag.ack_event(ag.AckRequest(seq=first[-1]), db=s, auth=auth)
                await s.commit()
        finally:
            await eng.dispose()
        await _connect_once(agent_id, auth)
        assert await _tests_for(agent_id) == first, "verified: a reconnect adds none"
