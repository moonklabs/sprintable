"""story #4509 AC1b (Mirko's measurement · PO 10:34Z) — a receiver's reconnect takes back its own slot.

A daemon that closes its stream (its waiting list full) and reconnects within seconds, or restarts (an upgrade), met a 429: the
old connection's per-key lease outlived it (a fresh uuid per connection), and the daemon read the 429 as «another place is
receiving». With `X-Sprintable-Receiver-Id` (one per desktop install) the same receiver's new connection hands the old one
over (`event: superseded`) and keeps the slot; another receiver still gets the 429; without the header nothing changes.
Both lease paths: the Redis lease (fakeredis + its Lua) and the in-process count.
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from tests.agent_stream_auth import agent_stream_claims, seed_agent_stream_key
from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_org, _make_project, _session_factory

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

# rows on the migrated schema, removed after — no create_all/drop_all (the schema-drift guard · story #3896)
pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

R1 = "rcv_" + "a" * 22
R2 = "rcv_" + "b" * 22


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(params=["redis", "in_process"])
def lease_path(request):
    from app.services import sse_lease

    if request.param == "in_process":
        with patch.object(sse_lease.settings, "sse_lease_redis_enabled", False):
            yield "in_process"
        return
    aioredis = pytest.importorskip("fakeredis.aioredis")
    pytest.importorskip("lupa")
    client = aioredis.FakeRedis(server=aioredis.FakeServer(), decode_responses=True)
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
         patch.object(sse_lease.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield "redis"


class _Req:
    def __init__(self, receiver: str | None = None):
        self.headers = {"x-sprintable-receiver-id": receiver} if receiver else {}

    async def is_disconnected(self) -> bool:
        return False


@asynccontextmanager
async def _world():
    import app.routers.agent_gateway as gw

    engine, Session = await _session_factory()
    org_id = None
    try:
        async with Session() as s:
            org = await _make_org(s)
            org_id = org.id
            project = await _make_project(s, org.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            key_id = await seed_agent_stream_key(s, agent_id)
        auth = MagicMock()
        auth.user_id = str(agent_id)
        auth.claims = agent_stream_claims(key_id)

        @asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw, "_AGENT_STREAM_TIER_LIMITS", {}), \
             patch.object(gw, "_AGENT_STREAM_DEFAULT_LIMIT", 1), \
             patch.object(gw, "_SSE_HEARTBEAT", 0.02), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            yield gw, auth, str(agent_id)
    finally:
        gw._agent_connections.pop(str(agent_id), None)
        for k in [k for k in gw._receiver_streams if k[0] == str(agent_id)]:
            gw._receiver_streams.pop(k, None)
        if org_id is not None:
            from sqlalchemy import text

            for stmt in (  # each on its own, best effort — leftovers carry fresh uuids and harm nothing
                "DELETE FROM agent_sessions WHERE agent_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM project_access WHERE member_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM agent_project_profiles WHERE member_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM members WHERE org_id = :o",
                "DELETE FROM projects WHERE org_id = :o",
                "DELETE FROM organizations WHERE id = :o",
            ):
                try:
                    async with Session() as s:
                        await s.execute(text(stmt), {"o": org_id})
                        await s.commit()
                except Exception:  # noqa: BLE001
                    pass
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


async def _drain(body, seconds: float = 5.0) -> list[str]:
    """The stream's frames until it ends — bounded, so a stream that never ends fails the test instead of hanging it."""
    chunks: list[str] = []

    async def _all():
        async for chunk in body:
            chunks.append(chunk)

    await asyncio.wait_for(_all(), seconds)
    return chunks


async def _refused(gw, auth, receiver):
    with pytest.raises(HTTPException) as e:
        await gw.agent_stream(request=_Req(receiver), auth=auth)
    return e.value


async def test_the_same_receiver_takes_its_slot_back_and_the_old_stream_ends_superseded(lease_path):
    from app.services import sse_lease

    async with _world() as (gw, auth, agent):
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        second = await gw.agent_stream(request=_Req(R1), auth=auth)  # before: 429 — the first still holds the slot
        old = await _drain(first.body_iterator)  # ends on its own — the hand-over told it to
        assert old[-1] == "event: superseded\ndata: {}\n\n"
        assert gw._receiver_streams[(agent, R1)] is not None
        if lease_path == "redis":
            assert await sse_lease.count(f"perkey:{agent}") == 1  # the superseded stream left the slot to the new one

        other = await _refused(gw, auth, R2)  # another receiver: the slot is taken
        assert other.status_code == 429
        await second.body_iterator.aclose()


async def test_without_the_header_nothing_changes_and_a_malformed_one_is_refused(lease_path):
    async with _world() as (gw, auth, _agent):
        first = await gw.agent_stream(request=_Req(None), auth=auth)
        again = await _refused(gw, auth, None)  # an old client reconnecting fast: 429 as before
        assert again.status_code == 429
        bad = await _refused(gw, auth, "rcv_short")
        assert bad.status_code == 422 and bad.detail["code"] == "invalid_receiver_id"
        await first.body_iterator.aclose()


async def test_a_refused_reconnect_does_not_end_the_stream_it_would_replace(lease_path):
    """The hand-over happens only after both limits pass: a reconnect refused by the global cap leaves the old stream on."""
    async with _world() as (gw, auth, agent):
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        with patch.object(gw, "_MAX_AGENT_SSE_CONNECTIONS", 0):
            refused = await _refused(gw, auth, R1)
        assert refused.status_code == 503
        queue = gw._receiver_streams[(agent, R1)]
        assert queue.empty()  # no superseded signal was sent
        await first.body_iterator.aclose()
