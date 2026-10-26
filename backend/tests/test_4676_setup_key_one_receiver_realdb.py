"""story #4676 (UX-1 · F4) — a key a desktop setup made is received in ONE place.

4509 gave every install a receiver id and let the same receiver's reconnect take its slot back; another receiver was still let
in while the plan's count allowed (free 3 · team 15 · pro 30) — so a second Mac with the same setup key received the same work.
Now: a setup key (`ApiKey.desktop_setup_id`) with another live receiver — `rcv:<other>` or a connection without the header —
is refused with 409 `another_receiver`; the same receiver's reconnect hands over as before; a hand-made key keeps the plan limit;
a connection without the header follows the one-receiver rule too (alone it receives, beside another it is refused).
`X-Sprintable-Receiver-Takeover: 1` (a person's [여기서 받기] only) ends the others and takes the slot — on this instance by the
superseded frame, on another instance by the lease mark its heartbeat reads. Three lease paths (fakeredis · Postgres rows (story 4791, Redis off) ·
in-process (the Postgres switch off)); the other-instance cases run on the first two — the lease is what the other instance sees.
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from tests.agent_stream_auth import agent_stream_claims
from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_org, _make_project, _session_factory

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

R1 = "rcv_" + "a" * 22
R2 = "rcv_" + "b" * 22


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(params=["redis", "postgres", "in_process"])
def lease_path(request):
    from app.services import sse_lease

    if request.param == "postgres":  # story 4791: Redis off, the lease in Postgres rows
        with patch.object(sse_lease.settings, "sse_lease_redis_enabled", False), \
             patch.object(sse_lease.settings, "sse_lease_pg_enabled", True):
            yield "postgres"
        return
    if request.param == "in_process":
        with patch.object(sse_lease.settings, "sse_lease_redis_enabled", False), \
             patch.object(sse_lease.settings, "sse_lease_pg_enabled", False):
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
    def __init__(self, receiver: str | None = None, takeover: bool = False):
        self.headers = {}
        if receiver:
            self.headers["x-sprintable-receiver-id"] = receiver
        if takeover:
            self.headers["x-sprintable-receiver-takeover"] = "1"

    async def is_disconnected(self) -> bool:
        return False


# story 4676 (Kadir 10-14): a stream another install TOOK OVER says so (`by`); a same-receiver hand-over (4509) stays `data: {}`
TAKEN_OVER_FRAME = 'event: superseded\ndata: {"by":"other_receiver"}\n\n'
SAME_RECEIVER_FRAME = "event: superseded\ndata: {}\n\n"

async def _seed_key(session, agent_id: uuid.UUID, org_id: uuid.UUID, *, setup: bool) -> uuid.UUID:
    """a live key for this agent — made by a desktop setup (a desktop_setups row it points at) or by hand (no setup)"""
    from app.models.api_key import ApiKey
    from app.models.desktop_setup import DesktopSetup

    setup_id = None
    if setup:
        row = DesktopSetup(
            id=uuid.uuid4(), code_hash=uuid.uuid4().hex, code_challenge=uuid.uuid4().hex, device_name="4676-mac",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1), org_id=org_id,
        )
        session.add(row)
        await session.flush()
        setup_id = row.id
    key = ApiKey(id=uuid.uuid4(), team_member_id=agent_id, key_prefix="sk_test_4676", key_hash=uuid.uuid4().hex, desktop_setup_id=setup_id)
    session.add(key)
    await session.commit()
    return key.id


@asynccontextmanager
async def _world(*, setup: bool = True, limit: int = 1):
    import app.routers.agent_gateway as gw

    engine, Session = await _session_factory()
    org_id = None
    try:
        async with Session() as s:
            org = await _make_org(s)
            org_id = org.id
            project = await _make_project(s, org.id)
            agent_id = await _make_agent_member(s, org.id, project.id)
            key_id = await _seed_key(s, agent_id, org.id, setup=setup)
        auth = MagicMock()
        auth.user_id = str(agent_id)
        auth.claims = agent_stream_claims(key_id)

        @asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw, "_AGENT_STREAM_TIER_LIMITS", {}), \
             patch.object(gw, "_AGENT_STREAM_DEFAULT_LIMIT", limit), \
             patch.object(gw, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw, "_PRESENCE_TICK_INTERVAL", 0.02), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            yield gw, auth, str(agent_id)
    finally:
        gw._agent_connections.pop(str(agent_id), None)
        for k in [k for k in gw._receiver_streams if k[0] == str(agent_id)]:
            gw._receiver_streams.pop(k, None)
        if org_id is not None:
            from sqlalchemy import text

            for stmt in (
                "DELETE FROM sse_leases WHERE scope IN (SELECT 'perkey:' || id::text FROM members WHERE org_id = :o)",
                "DELETE FROM sse_lease_taken WHERE scope IN (SELECT 'perkey:' || id::text FROM members WHERE org_id = :o)",
                "DELETE FROM agent_sessions WHERE agent_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM agent_api_keys WHERE team_member_id IN (SELECT id FROM members WHERE org_id = :o)",
                "DELETE FROM desktop_setups WHERE org_id = :o",
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
    chunks: list[str] = []

    async def _all():
        async for chunk in body:
            chunks.append(chunk)

    await asyncio.wait_for(_all(), seconds)
    return chunks


async def _refused(gw, auth, req):
    with pytest.raises(HTTPException) as e:
        await gw.agent_stream(request=req, auth=auth)
    return e.value


async def test_a_setup_key_refuses_another_receiver_with_409_inside_the_plan_limit(lease_path):
    async with _world(setup=True, limit=5) as (gw, auth, _agent):  # the plan would allow five — the setup key allows one place
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        other = await _refused(gw, auth, _Req(R2))
        assert other.status_code == 409
        assert other.detail["code"] == "another_receiver"
        assert other.headers.get("Retry-After") is not None
        headerless = await _refused(gw, auth, _Req(None))  # an old app beside a live receiver: refused too
        assert headerless.status_code == 409
        await first.body_iterator.aclose()


async def test_the_same_receiver_still_hands_over(lease_path):
    async with _world(setup=True, limit=5) as (gw, auth, agent):
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        second = await gw.agent_stream(request=_Req(R1), auth=auth)  # the reconnect, not a 409
        old = await _drain(first.body_iterator)
        assert old[-1] == SAME_RECEIVER_FRAME  # a reconnect of the SAME install is not a takeover: the daemon ends quietly (4509)
        assert gw._receiver_streams[(agent, R1)] is not None
        await second.body_iterator.aclose()


async def test_a_hand_made_key_keeps_the_plan_limit(lease_path):
    async with _world(setup=False, limit=2) as (gw, auth, _agent):
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        second = await gw.agent_stream(request=_Req(R2), auth=auth)  # two receivers inside the limit, as before
        third = await _refused(gw, auth, _Req("rcv_" + "c" * 22))
        assert third.status_code == 429  # the plan's count, not the one-receiver rule
        await first.body_iterator.aclose()
        await second.body_iterator.aclose()


async def test_a_connection_without_the_header_alone_still_receives(lease_path):
    async with _world(setup=True, limit=5) as (gw, auth, _agent):
        alone = await gw.agent_stream(request=_Req(None), auth=auth)  # an old app on a lone Mac is not cut
        later = await _refused(gw, auth, _Req(R2))  # but it holds the place: another receiver is refused
        assert later.status_code == 409
        await alone.body_iterator.aclose()


async def test_takeover_header_ends_the_other_receiver_and_takes_the_slot(lease_path):
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        second = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)  # a person's [여기서 받기] on the other install
        old = await _drain(first.body_iterator)
        assert old[-1] == TAKEN_OVER_FRAME
        assert (agent, R1) not in gw._receiver_streams
        if lease_path != "in_process":
            assert await sse_lease.members(f"perkey:{agent}") == [f"rcv:{R2}"]
            assert await sse_lease.taken_by(f"perkey:{agent}") == f"rcv:{R2}"
        # the first install's reconnect is now the one refused
        again = await _refused(gw, auth, _Req(R1))
        assert again.status_code == 409
        # the taker's stream runs (one frame read — an async generator never started runs no finally), then ends: its mark goes with it
        await anext(second.body_iterator)
        await second.body_iterator.aclose()
        if lease_path != "in_process":
            assert await sse_lease.taken_by(f"perkey:{agent}") is None


async def test_shared_lease_path_a_second_takeover_keeps_its_mark_when_the_first_taker_ends(lease_path):
    """까디르 4676 ①: R2 takes over from R1, then R3 takes over from R2 — R2's stream ends and clears only ITS mark: R3's stays
    (otherwise a stream pushed off on another instance would find no mark on its heartbeat and live again). R3's own end clears it."""
    if lease_path == "in_process":
        pytest.skip("the mark is the shared lease's (Redis or Postgres)")
    from app.services import sse_lease

    R3 = "rcv_" + "c" * 22
    async with _world(setup=True, limit=5) as (gw, auth, agent):
        scope = f"perkey:{agent}"
        first = await gw.agent_stream(request=_Req(R1), auth=auth)
        second = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)
        third = await gw.agent_stream(request=_Req(R3, takeover=True), auth=auth)
        assert await sse_lease.taken_by(scope) == f"rcv:{R3}"
        assert (await _drain(first.body_iterator))[-1] == TAKEN_OVER_FRAME
        assert (await _drain(second.body_iterator))[-1] == TAKEN_OVER_FRAME  # the first taker's stream ended …
        assert await sse_lease.taken_by(scope) == f"rcv:{R3}", "… and the second taker's mark is still there"
        assert await sse_lease.members(scope) == [f"rcv:{R3}"]
        await anext(third.body_iterator)
        await third.body_iterator.aclose()
        assert await sse_lease.taken_by(scope) is None, "the taker's own end clears its mark"


async def test_shared_lease_path_a_taker_is_pushed_off_when_the_owner_takes_it_back_on_another_instance(lease_path):
    """Kadir 01a13a34 (4676): B took the agent over here (its stream is `_took_over`); the displaced owner A presses [여기서 받기] on ANOTHER
    instance — that entry released B's lease member and left A's mark. B's heartbeat must read the mark (its own stream took over, which
    used to skip the read): A's mark is not B's member → B ends superseded and its refresh must not put B back (else two receive and the
    take-back is silently lost)."""
    if lease_path == "in_process":
        pytest.skip("the other-instance view is the shared lease's (Redis or Postgres)")
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        scope = f"perkey:{agent}"
        owner = await gw.agent_stream(request=_Req(R1), auth=auth)
        taker = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)  # B takes it over here: a `_took_over` stream
        assert (await _drain(owner.body_iterator))[-1] == TAKEN_OVER_FRAME
        assert await sse_lease.taken_by(scope) == f"rcv:{R2}"
        # what the owner's [여기서 받기] does on the other instance: release the taker's member, take the slot, leave its mark
        for m in await sse_lease.members(scope):
            await sse_lease.release(scope, m)
        await sse_lease.acquire(scope, 5, f"rcv:{R1}")
        await sse_lease.mark_taken(scope, f"rcv:{R1}")
        pushed = await _drain(taker.body_iterator)
        assert pushed[-1] == TAKEN_OVER_FRAME, "the taker was pushed off by the take-back"
        assert await sse_lease.members(scope) == [f"rcv:{R1}"], "the taker's refresh did not put itself back — one place receives"
        assert await sse_lease.taken_by(scope) == f"rcv:{R1}", "the owner's mark stands (the taker's end clears only its own)"


async def test_shared_lease_path_a_taker_keeps_receiving_through_its_own_heartbeats(lease_path):
    """the other side of the take-back test: a taker now READS the mark on its heartbeat — its own mark is its own member, so it must go on
    (not end itself) and keep its slot. Waits for several heartbeat frames (a count, not a clock) before it looks."""
    if lease_path == "in_process":
        pytest.skip("the mark is the shared lease's (Redis or Postgres)")
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        scope = f"perkey:{agent}"
        owner = await gw.agent_stream(request=_Req(R1), auth=auth)
        taker = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)
        assert (await _drain(owner.body_iterator))[-1] == TAKEN_OVER_FRAME
        frames: list[str] = []

        async def _pump():
            async for chunk in taker.body_iterator:
                frames.append(chunk)

        task = asyncio.create_task(_pump())
        try:
            for _ in range(1000):
                if sum("event: heartbeat" in f for f in frames) >= 5:
                    break
                await asyncio.sleep(0.01)
            assert sum("event: heartbeat" in f for f in frames) >= 5, "the taker's stream kept running through its heartbeats"
            assert not any("superseded" in f for f in frames), "a taker is not pushed off by its OWN mark"
            assert await sse_lease.members(scope) == [f"rcv:{R2}"]
            assert await sse_lease.taken_by(scope) == f"rcv:{R2}"
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 — the stream is torn down with the test world
                pass


@pytest.mark.parametrize("receiver", [None, R1], ids=["headerless", "receiver"])
async def test_shared_lease_path_a_stream_on_another_instance_ends_on_its_heartbeat_when_taken_over(lease_path, receiver):
    """the taker is on another instance: it released this stream's member and left the mark — this stream (a receiver, or an old app
    without the header) reads the mark on its heartbeat and ends superseded; its refresh (a ZADD) must not put the member back (PO 11:56Z)"""
    if lease_path == "in_process":
        pytest.skip("the other-instance view is the shared lease's (Redis or Postgres)")
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        scope = f"perkey:{agent}"
        first = await gw.agent_stream(request=_Req(receiver), auth=auth)
        mine = await sse_lease.members(scope)
        assert len(mine) == 1
        # what the taker's entry does on the other instance
        await sse_lease.release(scope, mine[0])
        await sse_lease.acquire(scope, 5, f"rcv:{R2}")
        await sse_lease.mark_taken(scope, f"rcv:{R2}")
        old = await _drain(first.body_iterator)
        assert old[-1] == TAKEN_OVER_FRAME
        assert await sse_lease.members(scope) == [f"rcv:{R2}"], "the refresh did not put the released member back"
        assert await sse_lease.taken_by(scope) == f"rcv:{R2}", "only the taker's own end clears the mark"


async def test_shared_lease_path_sees_a_receiver_on_another_instance(lease_path):
    """the other install's stream lives on another instance: only the lease knows it — the 409 reads the lease, the take-over releases it"""
    if lease_path == "in_process":
        pytest.skip("the other-instance view is the shared lease's (Redis or Postgres)")
    from app.services import sse_lease

    async with _world(setup=True, limit=5) as (gw, auth, agent):
        assert await sse_lease.acquire(f"perkey:{agent}", 5, f"rcv:{R1}") is True  # as another instance would have
        other = await _refused(gw, auth, _Req(R2))
        assert other.status_code == 409 and other.detail["code"] == "another_receiver"
        taken = await gw.agent_stream(request=_Req(R2, takeover=True), auth=auth)
        assert await sse_lease.members(f"perkey:{agent}") == [f"rcv:{R2}"]
        assert await sse_lease.taken_by(f"perkey:{agent}") == f"rcv:{R2}"
        await taken.body_iterator.aclose()
